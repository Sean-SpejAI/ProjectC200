// One-shot batch recovery for Sor docs that ended up with file_url=NULL
// during the initial backfill — usually because the source record contained
// zero pages at the time of sync. Re-attempts the proxy PDF fetch; if the
// source now has pages, the doc is upgraded to a real PDF and flipped to
// processing_status='pending' so the analyze watchdog picks it up. If the
// source is still empty, the doc is marked with the stable, recognizable
// error string 'source_has_no_pages' (replacing the misleading
// "Cannot read properties of null (reading 'match')" stack-trace string left
// over from the pre-PR-#73 analyze crash).
//
// Admin-only. verify_jwt=false at the platform layer (see config.toml);
// authorization is enforced in-function by requiring the Authorization
// header to carry the service role key. No UI caller — this is run via
// `curl` from an operator workstation.
//
// Mirrors the proxy + streaming-upload + DB-update pattern from
// fetch-sor-document. Bounded per-invocation budget so we stay under
// the 150 s edge gateway timeout — the caller re-invokes until
// summary.attempted == 0.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "X-Content-Type-Options": "nosniff",
};

const PER_INVOCATION_BUDGET_MS = 120_000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const PROXY_TIMEOUT_MS = 5 * 60_000;

interface RecoverRequest {
  dry_run?: boolean;
  limit?: number;
  // If set, opt out of the default exclusion (skipping rows already marked
  // 'source_has_no_pages:%') and instead select rows whose processing_error
  // matches this LIKE pattern. Used to retry rows marked during a known
  // upstream outage — e.g. retry_marker_like='%Connection Timeout Expired%'
  // re-processes just the VPN-corrupted ones without disturbing the legit
  // 'no_pages_for_document' ones.
  retry_marker_like?: string;
}

interface DocRow {
  id: string;
  claim_id: string;
  sor_document_id: number | null;
  file_name: string | null;
  document_type: string | null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorize(req: Request, serviceKey: string): boolean {
  const header = req.headers.get("Authorization") ?? "";
  const presented = header.replace(/^Bearer\s+/i, "");
  if (!presented) return false;
  return timingSafeEqual(presented, serviceKey);
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const SOR_PROXY_URL = Deno.env.get("SOR_PROXY_URL");
  const SOR_PROXY_TOKEN = Deno.env.get("SOR_PROXY_TOKEN");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "supabase_not_configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
  if (!SOR_PROXY_URL || !SOR_PROXY_TOKEN) {
    return new Response(JSON.stringify({ error: "sor_proxy_not_configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  if (!authorize(req, SUPABASE_SERVICE_ROLE_KEY)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Scanner guard goes AFTER auth so the scanner exercises the auth path.
  const scannerEarly = scannerShortCircuit(req, corsHeaders);
  if (scannerEarly) return scannerEarly;

  let body: RecoverRequest = {};
  if (req.method !== "GET") {
    try {
      body = (await req.json()) as RecoverRequest;
    } catch {
      body = {};
    }
  }
  const dryRun = body.dry_run === true;
  const limit = Math.min(Math.max(1, body.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const retryMarkerLike = body.retry_marker_like?.trim() || null;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Selection rules:
  //   - retry_marker_like provided → select rows whose processing_error
  //     matches that pattern (operator retrying a previously-marked batch)
  //   - default → exclude rows already marked 'source_has_no_pages:%' so the
  //     function naturally stops re-processing the same rows on subsequent
  //     invocations. Without this guard the loop would re-mark forever on
  //     transient upstream failures (the original bug — once the VPN dropped
  //     during the 2026-06-09 drain, the SELECT kept handing the same rows
  //     back to the function because the marker we wrote still satisfied
  //     `file_url IS NULL`).
  let query = supabase
    .from("claim_documents")
    .select("id, claim_id, sor_document_id, file_name, document_type")
    .eq("source", "sor")
    .is("file_url", null);

  if (retryMarkerLike) {
    query = query.like("processing_error", retryMarkerLike);
  } else {
    // postgrest `or` syntax — `*` is the LIKE wildcard inside supabase-js
    // (translated to `%` in the URL).
    query = query.or("processing_error.is.null,processing_error.not.like.source_has_no_pages:*");
  }

  const { data: rows, error: selectError } = await query
    .order("uploaded_at", { ascending: true })
    .limit(limit);

  if (selectError) {
    return new Response(
      JSON.stringify({ error: "select_failed", details: selectError.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  const targets = (rows ?? []) as DocRow[];

  if (dryRun) {
    return new Response(
      JSON.stringify({
        dry_run: true,
        mode: retryMarkerLike ? "retry_marker_like" : "default_exclude_already_marked",
        retry_marker_like: retryMarkerLike,
        attempted: 0,
        candidates: targets.length,
        sample: targets.slice(0, 5).map((r) => ({
          id: r.id,
          claim_id: r.claim_id,
          sor_document_id: r.sor_document_id,
          file_name: r.file_name,
          document_type: r.document_type,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  const started = Date.now();
  const results: Array<{ id: string; outcome: string; detail?: string }> = [];
  let recovered = 0;
  let stillEmpty = 0;
  let errored = 0;

  for (const row of targets) {
    if (Date.now() - started > PER_INVOCATION_BUDGET_MS) {
      // Bail out cleanly — caller re-invokes until attempted==0.
      break;
    }

    const irDocId = Number(row.sor_document_id);
    if (!Number.isFinite(irDocId) || irDocId <= 0) {
      results.push({ id: row.id, outcome: "skipped", detail: "missing sor_document_id" });
      errored += 1;
      continue;
    }

    try {
      const outcome = await recoverOne({
        row,
        irDocId,
        supabase,
        proxyUrl: SOR_PROXY_URL,
        proxyToken: SOR_PROXY_TOKEN,
      });
      results.push({ id: row.id, outcome: outcome.outcome, detail: outcome.detail });
      if (outcome.outcome === "recovered") recovered += 1;
      else if (outcome.outcome === "source_has_no_pages") stillEmpty += 1;
      else errored += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ id: row.id, outcome: "error", detail: message });
      errored += 1;
    }
  }

  return new Response(
    JSON.stringify({
      mode: retryMarkerLike ? "retry_marker_like" : "default_exclude_already_marked",
      retry_marker_like: retryMarkerLike,
      attempted: results.length,
      recovered,
      still_empty: stillEmpty,
      errored,
      remaining_candidates_after_limit: Math.max(0, targets.length - results.length),
      results,
    }),
    { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
  );
};

interface RecoverOneArgs {
  row: DocRow;
  irDocId: number;
  supabase: ReturnType<typeof createClient>;
  proxyUrl: string;
  proxyToken: string;
}

interface RecoverOneResult {
  outcome: "recovered" | "source_has_no_pages" | "proxy_error";
  detail?: string;
}

async function recoverOne(args: RecoverOneArgs): Promise<RecoverOneResult> {
  const { row, irDocId, supabase, proxyUrl, proxyToken } = args;
  const url = `${proxyUrl.replace(/\/$/, "")}/sor/documents/${encodeURIComponent(String(irDocId))}/pdf`;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${proxyToken}`,
        "Accept": "application/pdf",
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  // Treat content-unavailable signals from the proxy (and analogous body-empty
  // cases below) as "source_has_no_pages" — that's the stable marker we want
  // sitting in processing_error.
  if (!upstream.ok) {
    if (upstream.status === 403 || upstream.status === 404 || upstream.status === 502) {
      const text = await upstream.text();
      await markSourceEmpty(supabase, row.id, text.slice(0, 200));
      return { outcome: "source_has_no_pages", detail: `proxy ${upstream.status}` };
    }
    const text = await upstream.text();
    return { outcome: "proxy_error", detail: `proxy ${upstream.status}: ${text.slice(0, 200)}` };
  }

  const contentType = upstream.headers.get("content-type") || "application/pdf";
  const pageIdsHeader = upstream.headers.get("x-sor-page-ids") ?? "";
  const pageIds = pageIdsHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));

  if (!upstream.body) {
    await markSourceEmpty(supabase, row.id, "upstream returned no body");
    return { outcome: "source_has_no_pages", detail: "no body" };
  }

  // Stream + validate %PDF magic + count bytes, mirroring
  // fetch-sor-document so behavior is identical.
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
  const storageUuid = crypto.randomUUID();
  const resolvedFileName = row.file_name || `sor-doc-${irDocId}.pdf`;
  const storagePath = `sor/${storageUuid}/${resolvedFileName}`;

  try {
    const { error: uploadError } = await supabase.storage
      .from("claim-documents")
      .upload(storagePath, pdfStream, {
        contentType,
        upsert: false,
        duplex: "half",
      } as unknown as { contentType: string; upsert: boolean });
    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);
  } catch (err) {
    if (invalidHeader) {
      await markSourceEmpty(supabase, row.id, "response_not_pdf");
      return { outcome: "source_has_no_pages", detail: "non-pdf response" };
    }
    throw err;
  }

  const fileSize = bytesSeen;
  if (fileSize < 5) {
    await supabase.storage.from("claim-documents").remove([storagePath]).catch(() => {});
    await markSourceEmpty(supabase, row.id, "empty body");
    return { outcome: "source_has_no_pages", detail: "empty body" };
  }

  // Store the bare storage path; the bucket is private and PDFs are served via
  // the sign-claim-document edge proxy (server reads use service-role download).
  const updatePayload: Record<string, unknown> = {
    file_url: storagePath,
    file_size: fileSize,
    mime_type: contentType,
    processing_status: "pending",
    processing_error: null,
  };
  if (pageIds.length > 0) updatePayload.sor_page_ids = pageIds;

  const { error: updateError } = await supabase
    .from("claim_documents")
    .update(updatePayload)
    .eq("id", row.id);
  if (updateError) throw new Error(`DB update failed: ${updateError.message}`);

  return { outcome: "recovered" };
}

async function markSourceEmpty(
  supabase: ReturnType<typeof createClient>,
  docId: string,
  detail: string,
): Promise<void> {
  await supabase
    .from("claim_documents")
    .update({
      processing_status: "failed",
      processing_error: `source_has_no_pages: ${detail}`.slice(0, 500),
    })
    .eq("id", docId);
}

serve(handler);
