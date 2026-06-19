// PDF content fetch for one ImageRight document. Called by:
//   - imageright-pull-claim (per-claim worker, after the row was created
//     in pending_content state)
//   - imageright-sync's pending_content sweep (existing row to retry)
//
// Most documents are one merged PDF: the proxy's GET /imageright/documents/:id/pdf
// streams `application/pdf` and surfaces the underlying page ids via the
// `X-ImageRight-Page-Ids` header. We also store the per-page manifest from
// /pages for the document tree + citations.
//
// LARGE documents: ImageRight faults when asked to render a very large PDF in
// one GetMultiPageImageFileUsingPages call (~668 pages → sax_error at ~134s).
// So a doc with more than CHUNK_PAGES renderable pages is fetched in ≤CHUNK_PAGES
// ranges and stored as multiple "part" rows (the same head/child model the
// analyze-claim-document resplit uses: page_start/page_end + manifest slice).
// The work is RESUMABLE and time-boxed — each invocation fetches as many missing
// parts as fit in its budget; a re-fire (the pull skips done docs) finishes the rest.
//
// On a recoverable content error the function returns HTTP 200 +
// `{success:false, error:"content_unavailable"}` so the caller keeps the row in
// pending_content for the daily diff to retry. Real infra failures return 502/500.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";
import { dispatchForAnalysis } from "../_shared/dispatch-analysis.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "X-Content-Type-Options": "nosniff",
};

// Pages per range when fetching an oversized document. Validated against the
// upstream limit: 150 pages renders in ~69s, 250 in ~105s, while ~668 faults at
// ~134s — so 120 leaves a comfortable margin.
const CHUNK_PAGES = 120;
// Stop starting new part fetches past this elapsed time. Each part takes ~60-130s
// (proxy render + stream-to-storage), so this keeps an invocation to ~1-2 parts
// and leaves ample headroom under the 400s worker wall-clock for the per-part
// dispatch + the final supersede bookkeeping. Remaining parts resume on the next
// fetch (parts already created are skipped). Drive big docs SEQUENTIALLY — two
// concurrent multi-part fetches contend for the proxy/VPN and slow each other.
const MULTIPART_BUDGET_MS = 180_000;

interface FetchRequest {
  documentId: string;                // claim_documents.id (UUID) — row already exists in pending_content
  imageright_document_id: number | string;
  claimId: string;
  documentType?: string;
  fileName?: string;
}

// One entry of the proxy's /pages manifest (n = merged-PDF page ordinal).
interface IRPageManifestEntry {
  n: number | null;
  irPageId: number;
  format: string | null;
  rendered: boolean;
}

// Sanitize a file name for use as a Storage object KEY. Storage rejects keys
// with characters like [] ' @ etc.; the rich display name (with the "[#id]"
// uniqueness suffix) is kept separately in claim_documents.file_name. Mirrors
// the resplit path's sanitizer.
function sanitizeStorageName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180);
}

type StreamResult =
  | { ok: true; fileSize: number; pageIds: number[]; contentType: string }
  | { ok: false; kind: "content_unavailable" | "error"; message: string; status?: number };

// Fetch a PDF (optionally a page range) from the proxy and STREAM it straight to
// Storage — never buffering the whole file (client PDFs reach 100+ MB; buffering
// OOMs the worker). Validates the leading "%PDF" magic bytes and counts bytes.
async function fetchPdfToStorage(
  supabase: SupabaseClient,
  url: string,
  token: string,
  storagePath: string,
): Promise<StreamResult> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 6 * 60_000);
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/pdf" },
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, kind: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => "");
    // Permission denied / upstream content fault → recoverable (keep pending_content).
    if (upstream.status === 403 || upstream.status === 404 || upstream.status === 502) {
      return { ok: false, kind: "content_unavailable", message: errorText.slice(0, 500), status: upstream.status };
    }
    return { ok: false, kind: "error", message: `status=${upstream.status} ${errorText.slice(0, 300)}`, status: upstream.status };
  }

  const contentType = upstream.headers.get("content-type") || "application/pdf";
  const pageIdsHeader = upstream.headers.get("x-imageright-page-ids") ?? "";
  const pageIds = pageIdsHeader.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    .map((s) => Number(s)).filter((n) => Number.isFinite(n));
  const skippedNonImage = Number(upstream.headers.get("x-imageright-skipped-non-image") ?? "0");
  if (skippedNonImage > 0) console.log(`fetch-imageright-document: ${skippedNonImage} non-image page(s) excluded`);
  if (!upstream.body) return { ok: false, kind: "error", message: "Upstream returned no body" };

  let bytesSeen = 0;
  const headerBuf = new Uint8Array(4);
  let headerPos = 0;
  let headerValidated = false;
  let invalidHeader = false;
  const validator = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!headerValidated) {
        const need = 4 - headerPos;
        const copy = Math.min(need, chunk.byteLength);
        headerBuf.set(chunk.subarray(0, copy), headerPos);
        headerPos += copy;
        if (headerPos >= 4) {
          if (String.fromCharCode(...headerBuf) !== "%PDF") {
            invalidHeader = true;
            controller.error(new Error("response_not_pdf"));
            return;
          }
          headerValidated = true;
        }
      }
      bytesSeen += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const pdfStream = upstream.body.pipeThrough(validator);

  try {
    const { error: uploadError } = await supabase.storage.from("claim-documents").upload(
      storagePath,
      pdfStream,
      { contentType, upsert: false, duplex: "half" } as unknown as { contentType: string; upsert: boolean },
    );
    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);
  } catch (err) {
    if (invalidHeader) return { ok: false, kind: "content_unavailable", message: "response_not_pdf" };
    return { ok: false, kind: "error", message: err instanceof Error ? err.message : String(err) };
  }

  if (bytesSeen < 5) {
    await supabase.storage.from("claim-documents").remove([storagePath]).catch(() => {});
    return { ok: false, kind: "content_unavailable", message: "empty_response" };
  }
  return { ok: true, fileSize: bytesSeen, pageIds, contentType };
}

// Fetch the per-page manifest from the proxy /pages route. Best-effort.
async function fetchManifest(
  proxyBase: string,
  token: string,
  irDocId: number,
): Promise<{ pages: IRPageManifestEntry[]; renderedCount: number } | null> {
  try {
    const res = await fetch(`${proxyBase}/imageright/documents/${encodeURIComponent(String(irDocId))}/pages`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
    });
    if (!res.ok) return null;
    const m = await res.json() as { pages?: IRPageManifestEntry[]; renderedPageCount?: number };
    if (!Array.isArray(m?.pages)) return null;
    const renderedCount = typeof m.renderedPageCount === "number"
      ? m.renderedPageCount
      : m.pages.filter((p) => p.rendered).length;
    return { pages: m.pages, renderedCount };
  } catch {
    return null;
  }
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const scannerEarly = scannerShortCircuit(req, corsHeaders);
  if (scannerEarly) return scannerEarly;

  try {
    const IMAGERIGHT_PROXY_URL = Deno.env.get("IMAGERIGHT_PROXY_URL");
    const IMAGERIGHT_PROXY_TOKEN = Deno.env.get("IMAGERIGHT_PROXY_TOKEN");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!IMAGERIGHT_PROXY_URL || !IMAGERIGHT_PROXY_TOKEN) throw new Error("ImageRight proxy is not configured");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase admin credentials are not configured");

    const body: FetchRequest = await req.json();
    const { documentId, imageright_document_id, claimId, documentType, fileName } = body;
    if (!documentId || !imageright_document_id || !claimId) {
      return json({ error: "missing_required_fields: documentId, imageright_document_id, claimId" }, 400);
    }

    const irDocId = Number(imageright_document_id);
    const proxyBase = IMAGERIGHT_PROXY_URL.replace(/\/$/, "");
    const pdfUrl = `${proxyBase}/imageright/documents/${encodeURIComponent(String(irDocId))}/pdf`;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const resolvedFileName = fileName || `ir-doc-${irDocId}.pdf`;

    // Manifest first — it drives the single-vs-multipart decision and is stored
    // for the document tree. Cheap (one GetPages); robust for 1000+ page docs.
    const manifest = await fetchManifest(proxyBase, IMAGERIGHT_PROXY_TOKEN, irDocId);
    const renderedCount = manifest?.renderedCount ?? 0;

    // -------------------------------------------------------------------------
    // SINGLE-DOC path: small enough to render in one upstream call.
    // -------------------------------------------------------------------------
    if (!manifest || renderedCount <= CHUNK_PAGES) {
      const storagePath = `imageright/${crypto.randomUUID()}/${sanitizeStorageName(resolvedFileName)}`;
      const r = await fetchPdfToStorage(supabase, pdfUrl, IMAGERIGHT_PROXY_TOKEN, storagePath);
      if (!r.ok) {
        if (r.kind === "content_unavailable") {
          return json({ success: false, error: "content_unavailable", upstream_status: r.status ?? 200, upstream_message: r.message });
        }
        return json({ success: false, error: "proxy_request_failed", details: r.message }, 502);
      }
      const updatePayload: Record<string, unknown> = {
        file_url: storagePath,
        file_size: r.fileSize,
        mime_type: r.contentType,
        processing_status: "pending",
        processing_error: null,
      };
      if (r.pageIds.length > 0) updatePayload.imageright_page_ids = r.pageIds;
      if (manifest && manifest.pages.length > 0) updatePayload.imageright_pages = manifest.pages;
      if (documentType) updatePayload.document_type = documentType;
      if (resolvedFileName) updatePayload.file_name = resolvedFileName;
      const { error: updateError } = await supabase.from("claim_documents").update(updatePayload).eq("id", documentId);
      if (updateError) throw new Error(`DB update failed: ${updateError.message}`);
      return json({ success: true, documentId, fileUrl: storagePath, fileSize: r.fileSize, pageIds: r.pageIds });
    }

    // -------------------------------------------------------------------------
    // MULTI-PART path: fetch in ≤CHUNK_PAGES ranges → one "part" row each.
    // Resumable: skip parts that already exist; time-boxed per invocation.
    // -------------------------------------------------------------------------
    const { data: head } = await supabase
      .from("claim_documents")
      .select("claim_id, imageright_processing_tier, document_type")
      .eq("id", documentId)
      .maybeSingle();
    const claimIdResolved = (head?.claim_id as string | null) ?? claimId;
    const tier = (head?.imageright_processing_tier as string | null) ?? null;
    const headDocType = documentType || (head?.document_type as string | null) || "imageright-import";
    const baseName = resolvedFileName.replace(/\.pdf$/i, "");
    const rendered = manifest.pages.filter((p) => p.rendered && typeof p.n === "number");
    const partsTotal = Math.ceil(renderedCount / CHUNK_PAGES);

    const { data: existingParts } = await supabase
      .from("claim_documents")
      .select("claim_details")
      .filter("claim_details->>resplit_of", "eq", documentId);
    const existingPartNums = new Set<number>(
      (existingParts ?? []).map((r) => Number((r.claim_details as Record<string, unknown>)?.resplit_part)).filter((n) => Number.isFinite(n)),
    );

    // Store the manifest on the head UP-FRONT so the document tree works even
    // before all parts land — and survives a mid-run kill (the head is the
    // page-collection node; its pages resolve to the part slices).
    await supabase.from("claim_documents").update({ imageright_pages: manifest.pages }).eq("id", documentId);

    const startedAt = Date.now();
    let createdThisRun = 0;
    for (let i = 1; i <= partsTotal; i++) {
      if (existingPartNums.has(i)) continue;
      if (Date.now() - startedAt > MULTIPART_BUDGET_MS) break; // resume next fetch
      const from = (i - 1) * CHUNK_PAGES + 1;
      const to = Math.min(i * CHUNK_PAGES, renderedCount);
      const displayName = `${baseName} · part ${i} of ${partsTotal} (pp. ${from}-${to}).pdf`;
      const partPath = `imageright/${crypto.randomUUID()}/${sanitizeStorageName(displayName)}`;
      const r = await fetchPdfToStorage(
        supabase,
        `${pdfUrl}?from=${from}&to=${to}`,
        IMAGERIGHT_PROXY_TOKEN,
        partPath,
      );
      if (!r.ok) {
        console.log("fetch-imageright-document multipart: range fetch failed", { documentId, i, from, to, kind: r.kind, message: r.message });
        continue; // try the rest; this part retries on the next pull
      }
      const sliceManifest = rendered.filter((p) => (p.n as number) >= from && (p.n as number) <= to);
      const { data: inserted, error: insErr } = await supabase
        .from("claim_documents")
        .insert({
          claim_id: claimIdResolved,
          source: "imageright",
          file_name: displayName,
          file_url: partPath,
          file_size: r.fileSize,
          mime_type: r.contentType,
          document_type: headDocType,
          processing_status: "pending",
          imageright_pages: sliceManifest,
          imageright_processing_tier: tier,
          claim_details: {
            original_file_name: resolvedFileName,
            page_start: from,
            page_end: to,
            resplit_of: documentId,
            resplit_part: i,
            resplit_count: partsTotal,
            resplit_depth: 0,
          },
        })
        .select("id")
        .single();
      if (insErr) {
        // 23505 = another invocation already created this part (unique on
        // resplit_of+resplit_part) → fine; remove the orphan upload.
        if ((insErr as { code?: string }).code === "23505") {
          await supabase.storage.from("claim-documents").remove([partPath]).catch(() => {});
        } else {
          console.log("fetch-imageright-document multipart: part insert failed", { documentId, i, message: insErr.message });
        }
        continue;
      }
      createdThisRun += 1;
      // Dispatch each part AS IT LANDS, so a later kill still leaves it queued
      // for analysis (the staged-redispatch watchdog is the backstop).
      if (inserted?.id) await dispatchForAnalysis(supabase, inserted.id as string).catch(() => {});
    }

    // Re-count parts to decide complete vs. resume.
    const { count: partsNow } = await supabase
      .from("claim_documents")
      .select("id", { count: "exact", head: true })
      .filter("claim_details->>resplit_of", "eq", documentId);
    const complete = (partsNow ?? 0) >= partsTotal;

    if (complete) {
      // The head carries no content of its own — supersede it (kept in the tree
      // as the page-collection node; its pages resolve to the part slices).
      await supabase.from("claim_documents").update({
        processing_status: "superseded",
        ai_summary: `Fetched in ${partsTotal} parts (${renderedCount} pages).`,
        processing_error: null,
      }).eq("id", documentId);
    } else {
      // Keep pending_content so the next fetch resumes (skips existing parts).
      await supabase.from("claim_documents").update({
        processing_error: `multipart in progress: ${partsNow ?? 0}/${partsTotal} parts`,
      }).eq("id", documentId);
    }

    return json({
      success: true,
      multipart: true,
      complete,
      documentId,
      partsCreated: partsNow ?? createdThisRun,
      partsTotal,
    });
  } catch (error) {
    console.error("fetch-imageright-document error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return json({ success: false, error: message }, 500);
  }
};

serve(handler);
