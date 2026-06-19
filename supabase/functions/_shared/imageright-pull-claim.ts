// Per-claim worker: fetches one ImageRight file (claim) + its documents,
// upserts the matching rows, and either kicks the analyze pipeline (PDF
// downloaded) or leaves the document in pending_content state (proxy
// reported content_unavailable).
//
// Under the SOAP redesign this is much simpler than the prior REST flow:
//   * one GetFileTree call returns file metadata + attributes + all
//     documents across all sub-folders;
//   * per-document content is one PDF (not per-page), fetched as a single
//     application/pdf round-trip by the fetch-imageright-document worker.
//
// Reused by:
//   - imageright-sync (bulk + daily-diff orchestrator)
//   - reload-claim-from-imageright (admin-triggered single-claim refresh)
//
// No HTTP entry point — this is a library module.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { dispatchForAnalysis } from "./dispatch-analysis.ts";
import { clientFromEnv, type IRFileTree, type IRTreeDocument } from "./imageright-client.ts";
import { tierForType } from "./imageright-doc-tier.ts";
import { maybeFireSynthesis } from "./fire-synthesis.ts";
import { storagePathFromFileUrl } from "./storage-path.ts";
import { DEFAULT_RECONCILE_THRESHOLDS, decideReconcileMode } from "./reconcile-decision.ts";
import type { ReconcileMode, ReconcileThresholds, TreeDiff } from "./reconcile-decision.ts";
// Re-export so the orchestrator (imageright-sync) can import these from here.
export { DEFAULT_RECONCILE_THRESHOLDS, decideReconcileMode };
export type { ReconcileMode, ReconcileThresholds, TreeDiff };

export interface PullResult {
  status:
    | "succeeded"
    | "content_pending"
    | "failed"
    | "skipped_insufficient_docs"
    // Reconcile aborted: the fresh ImageRight tree came back empty while we hold
    // documents — treated as a transient blip, never wipes the claim.
    | "reconcile_skipped_empty"
    // Reconcile detected but the claim's analysis was human-edited; held for
    // approval (synthesis_status='awaiting_approval' + pending_reconcile set).
    | "reconcile_awaiting_approval";
  claim_id: string | null;
  claim_number: string | null;
  docs_created: number;
  docs_updated: number;
  docs_pending_content: number;
  docs_with_content: number;
  // Reconcile decision for this pull ('noop'|'incremental'|'full'); unset when
  // not a reconcile pull.
  reconcile_mode?: ReconcileMode;
  // Documents soft-removed because they vanished from ImageRight.
  docs_removed?: number;
  // Documents present in ImageRight that were skipped by a folderFilter (if any).
  docs_filtered_out: number;
  // Empty/cut documents (ImageRight page count 0) skipped at pull — no row,
  // no content fetch, no analysis.
  docs_skipped_empty?: number;
  // Total doc count returned by GetFileTree (before any minDocs filter).
  // Used by the orchestrator for audit + the "skipped" reason.
  total_docs_in_source?: number;
  errors: Array<{ stage: string; message: string; retryable: boolean }>;
}

// Folder/document-type scoping for a curated pull. When provided, only
// documents satisfying the filter are synced; the rest are skipped and counted
// in PullResult.docs_filtered_out. Matching is case-insensitive.
export interface FolderFilter {
  // Keep a doc if ANY of its folderPath segments matches one of these
  // (exact or substring). Omit/empty = no include restriction.
  includeFolders?: string[];
  // Drop a doc if ANY of its folderPath segments matches one of these.
  // Exclude takes precedence over include.
  excludeFolders?: string[];
  // If set, keep only docs whose documentType OR documentTypeCode matches.
  documentTypes?: string[];
}

export interface PullOpts {
  runId: string;
  isReload?: boolean;
  triggeredBy?: string;
  // Curated folder/type scoping (targeted pulls). Applied per document.
  folderFilter?: FolderFilter;
  // Curated-load gate: if the ImageRight file has fewer than `minDocs`
  // documents, the worker SKIPS the per-doc content fetch and returns a
  // "skipped_insufficient_docs" status. The claim row is still upserted (so
  // we can audit what was filtered) but no PDFs are pulled. The
  // orchestrator uses this to cap a curated reload at N claims that meet a
  // doc-count threshold.
  minDocs?: number;
  // Daily-diff reconcile mode. When set AND the claim already exists, diff the
  // fresh ImageRight tree against our stored docs and choose incremental (fetch
  // only new/changed docs + soft-remove vanished ones) vs full (wipe + re-pull)
  // vs noop. The scheduled sync sets this; admin/on-demand pulls leave it off.
  reconcile?: boolean;
  // Thresholds for the incremental-vs-full decision. The orchestrator loads
  // these ONCE per run (loadReconcileThresholds) and threads them in; absent →
  // DEFAULT_RECONCILE_THRESHOLDS.
  reconcileThresholds?: ReconcileThresholds;
  // Bypass the human-edit approval gate. When a reconcile would change a claim
  // whose analysis a human has edited, pullClaim normally HOLDS it for approval
  // (status 'awaiting_approval' + pending_reconcile). Set this (from the
  // approve-reconcile edge fn) to apply the held reconcile.
  approvedReconcile?: boolean;
  // The reconcile mode the reviewer actually approved. If the recomputed mode is
  // MORE destructive than this (e.g. ImageRight changed again so 'incremental'
  // became 'full'), pullClaim RE-HOLDS for fresh approval instead of applying.
  approvedMode?: ReconcileMode;
}

const STORAGE_BUCKET = "claim-documents";

function getSupabase(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

// Best-effort normalization of varied date formats into YYYY-MM-DD.
function normalizeDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const m1 = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    const [_, mm, dd, yyyy] = m1;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  return null;
}

// Pass a TIMESTAMPTZ-friendly value through, nulling ImageRight's DateTime.MinValue
// sentinel ("0001-01-01T00:00:00") which serializes for unset dates.
function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = value.trim();
  if (!t || t.startsWith("0001-")) return null;
  return t;
}

// Build the denormalized folder chain for a document: ordered root → immediate
// parent as [{id,name}]. The SOAP tree only exposes folder *names* for the path
// plus the immediate parent's id, so ancestor ids are null.
function buildFolderPath(doc: IRTreeDocument): Array<{ id: number | null; name: string }> | null {
  const names = (doc.folderPath ?? []).filter((s) => typeof s === "string" && s.trim().length > 0);
  if (names.length === 0) return null;
  return names.map((name, i) => ({
    name,
    id: i === names.length - 1 ? (doc.parentFolderId ?? null) : null,
  }));
}

function recordError(result: PullResult, stage: string, message: string, retryable: boolean) {
  result.errors.push({ stage, message: message.slice(0, 500), retryable });
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toString().toLowerCase().trim();
}

// Decide whether a document passes the curated folder/type filter. Returns
// true (keep) when no filter is set. Exclude wins over include.
function passesFolderFilter(doc: IRTreeDocument, filter?: FolderFilter): boolean {
  if (!filter) return true;
  const segments = (doc.folderPath ?? []).map(norm).filter((s) => s.length > 0);
  const segMatches = (needle: string): boolean => {
    const n = norm(needle);
    return n.length > 0 && segments.some((seg) => seg === n || seg.includes(n));
  };

  if (filter.excludeFolders?.length && filter.excludeFolders.some(segMatches)) return false;
  if (filter.includeFolders?.length && !filter.includeFolders.some(segMatches)) return false;

  if (filter.documentTypes?.length) {
    const dt = norm(doc.documentType);
    const dtc = norm(doc.documentTypeCode);
    const typeMatches = filter.documentTypes.some((t) => {
      const n = norm(t);
      return n.length > 0 && (dt === n || dtc === n || dt.includes(n) || dtc.includes(n));
    });
    if (!typeMatches) return false;
  }
  return true;
}

// ============================================================================
// Reconcile (daily-diff) support
// (ReconcileMode / ReconcileThresholds / DEFAULT_RECONCILE_THRESHOLDS / TreeDiff
//  / decideReconcileMode are the pure, unit-tested pieces in reconcile-decision.ts,
//  imported + re-exported above.)
// ============================================================================

// Load reconcile thresholds from imageright_settings (name/value rows), falling
// back to defaults per-key. The orchestrator reads this ONCE per run.
export async function loadReconcileThresholds(supabase: SupabaseClient): Promise<ReconcileThresholds> {
  const d = DEFAULT_RECONCILE_THRESHOLDS;
  try {
    const { data } = await supabase
      .from("imageright_settings")
      .select("name, value")
      .in("name", [
        "reconcile_full_min_changed_fraction",
        "reconcile_full_min_added_abs",
        "reconcile_full_max_removed_fraction",
        "reconcile_full_on_folder_reorg",
        "reconcile_purge_storage_on_remove",
      ]);
    const map = new Map((data ?? []).map((r: { name: string; value: string }) => [r.name, r.value]));
    const num = (k: string, fallback: number): number => {
      const v = parseFloat(map.get(k) ?? "");
      return Number.isFinite(v) ? v : fallback;
    };
    const bool = (k: string, fallback: boolean): boolean => {
      const v = map.get(k);
      return v == null ? fallback : v === "true";
    };
    return {
      fullMinChangedFraction: num("reconcile_full_min_changed_fraction", d.fullMinChangedFraction),
      fullMinAddedAbs: num("reconcile_full_min_added_abs", d.fullMinAddedAbs),
      fullMaxRemovedFraction: num("reconcile_full_max_removed_fraction", d.fullMaxRemovedFraction),
      fullOnFolderReorg: bool("reconcile_full_on_folder_reorg", d.fullOnFolderReorg),
      purgeStorageOnRemove: bool("reconcile_purge_storage_on_remove", d.purgeStorageOnRemove),
    };
  } catch {
    return d;
  }
}

// Compare two TIMESTAMPTZ-ish values, tolerant of format/timezone serialization
// and ImageRight's DateTime.MinValue sentinel (→ null).
function tsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeTimestamp(a ?? null);
  const nb = normalizeTimestamp(b ?? null);
  if (na == null && nb == null) return true;
  if (na == null || nb == null) return false;
  const ta = Date.parse(na);
  const tb = Date.parse(nb);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return na === nb;
  return ta === tb;
}

function folderKey(path: Array<{ name?: string | null }> | null | undefined): string {
  return (path ?? []).map((s) => norm(s?.name)).join("/");
}

// Diff the fresh ImageRight tree against the claim's stored ACTIVE rows.
async function computeTreeDiff(
  supabase: SupabaseClient,
  claimId: string,
  freshDocs: IRTreeDocument[],
): Promise<TreeDiff> {
  const { data: rows } = await supabase
    .from("claim_documents")
    .select("id, imageright_document_id, imageright_last_modified, imageright_page_count, imageright_folder_path, claim_details")
    .eq("claim_id", claimId)
    .is("imageright_removed_at", null);
  const stored = rows ?? [];

  const storedHeads = stored.filter((r) => r.imageright_document_id != null);
  const storedById = new Map<number, (typeof storedHeads)[number]>(
    storedHeads.map((r) => [Number(r.imageright_document_id), r]),
  );
  const freshById = new Map<number, IRTreeDocument>(freshDocs.map((d) => [Number(d.docId), d]));

  const added: number[] = [];
  const modified: number[] = [];
  let folderChanged = false;
  const storedFolderSet = new Set(
    storedHeads.map((r) => folderKey(r.imageright_folder_path as Array<{ name?: string | null }> | null)),
  );

  for (const [id, doc] of freshById) {
    const fk = folderKey(buildFolderPath(doc));
    const head = storedById.get(id);
    if (!head) {
      added.push(id);
      if (!storedFolderSet.has(fk)) folderChanged = true; // a new folder appeared
      continue;
    }
    const samePages = doc.pageCount == null || head.imageright_page_count === doc.pageCount;
    if (!tsEqual(head.imageright_last_modified, doc.dateLastModified) || !samePages) {
      modified.push(id);
    }
    if (fk !== folderKey(head.imageright_folder_path as Array<{ name?: string | null }> | null)) {
      folderChanged = true; // a document moved
    }
  }

  const removed: number[] = [];
  const removedHeadRowIds: string[] = [];
  for (const [id, head] of storedById) {
    if (!freshById.has(id)) {
      removed.push(id);
      removedHeadRowIds.push(head.id as string);
    }
  }

  // Expand removed heads to their resplit descendants so a removed page
  // collection takes its parts/chunks with it instead of leaking them.
  const childrenByParent = new Map<string, string[]>();
  for (const r of stored) {
    const parent = (r.claim_details as { resplit_of?: string } | null)?.resplit_of;
    if (parent) {
      const arr = childrenByParent.get(parent) ?? [];
      arr.push(r.id as string);
      childrenByParent.set(parent, arr);
    }
  }
  const removedRowIds: string[] = [];
  const seen = new Set<string>();
  const queue = [...removedHeadRowIds];
  while (queue.length) {
    const rid = queue.shift()!;
    if (seen.has(rid)) continue;
    seen.add(rid);
    removedRowIds.push(rid);
    for (const kid of childrenByParent.get(rid) ?? []) queue.push(kid);
  }

  return {
    isKnown: stored.length > 0,
    storedCount: storedHeads.length,
    freshCount: freshDocs.length,
    added,
    modified,
    removed,
    removedRowIds,
    folderChanged,
  };
}

// Soft-remove the given rows (mark imageright_removed_at; optionally purge the
// stored PDF). Excludes them from the tree + synthesis; reversible on re-pull.
async function softRemoveDocs(
  supabase: SupabaseClient,
  rowIds: string[],
  purgeStorage: boolean,
  result: PullResult,
): Promise<void> {
  if (rowIds.length === 0) return;
  if (purgeStorage) {
    const { data: rows } = await supabase.from("claim_documents").select("file_url").in("id", rowIds);
    const paths = (rows ?? [])
      .map((r) => (r.file_url ? storagePathFromFileUrl(String(r.file_url)) : null))
      .filter((p): p is string => !!p);
    if (paths.length > 0) {
      const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(paths);
      if (error) recordError(result, "soft_remove_storage", error.message, false);
    }
  }
  const { error } = await supabase
    .from("claim_documents")
    .update({ imageright_removed_at: new Date().toISOString() })
    .in("id", rowIds);
  if (error) {
    recordError(result, "soft_remove", error.message, false);
    return;
  }
  result.docs_removed = (result.docs_removed ?? 0) + rowIds.length;
}

export async function pullClaim(fileId: number, opts: PullOpts): Promise<PullResult> {
  const supabase = getSupabase();
  const ir = clientFromEnv();

  const result: PullResult = {
    status: "succeeded",
    claim_id: null,
    claim_number: null,
    docs_created: 0,
    docs_updated: 0,
    docs_pending_content: 0,
    docs_with_content: 0,
    docs_filtered_out: 0,
    docs_skipped_empty: 0,
    errors: [],
  };

  // 1. File metadata + full document tree (one call) --------------------------
  const tree = await ir.getFileTree(fileId);
  if (!tree.ok || !tree.tree) {
    recordError(result, "file_metadata",
      `status=${tree.error?.status ?? 0} ${tree.error?.upstreamMessage ?? "unknown"}`,
      !!tree.error?.retryableExhausted);
    result.status = "failed";
    return result;
  }
  const { file, attributes, documents } = tree.tree;

  // ImageRight's File-level last-modified comes back as DateTime.MinValue,
  // but the freshest folder/document modified date is the meaningful proxy
  // for "claim was touched on day X". Take the max across documents.
  const docModTimes = documents
    .map((d) => d.dateLastModified)
    .filter((v): v is string => !!v && !v.startsWith("0001-"));
  const claimLastModified = docModTimes.length > 0
    ? docModTimes.reduce((a, b) => (a > b ? a : b))
    : null;

  const claimPayload = {
    source: "imageright" as const,
    imageright_file_id: file.fileId,
    imageright_last_modified: claimLastModified,
    imageright_synced_at: new Date().toISOString(),
    claim_number: file.claimNumber || null,
    claimant_name: file.description || null,
    policy_number: attributes["POLICY NUMBER"] || null,
    incident_date: normalizeDate(attributes["DATE OF LOSS"]),
    incident_description: attributes["CAUSE OF LOSS"] || null,
  };

  // 2. Upsert claim (keyed on imageright_file_id) -----------------------------
  const { data: existingClaim } = await supabase
    .from("claims")
    .select("id, synthesis_human_edited_at")
    .eq("imageright_file_id", file.fileId)
    .maybeSingle();

  let claimId: string;
  if (existingClaim?.id) {
    claimId = existingClaim.id;
    const { error } = await supabase
      .from("claims")
      .update(claimPayload)
      .eq("id", claimId);
    if (error) {
      recordError(result, "claim_update", error.message, false);
      result.status = "failed";
      return result;
    }
  } else {
    const { data: inserted, error } = await supabase
      .from("claims")
      .insert({ ...claimPayload, status: "pending" })
      .select("id")
      .single();
    if (error || !inserted) {
      recordError(result, "claim_insert", error?.message ?? "no_row_returned", false);
      result.status = "failed";
      return result;
    }
    claimId = inserted.id;
  }
  result.claim_id = claimId;
  result.claim_number = claimPayload.claim_number;
  result.total_docs_in_source = documents.length;

  // 2.5. Curated-load gate: if caller asked for minDocs and this claim has
  // fewer documents, skip the entire per-doc content fetch. The claim row
  // stays upserted (we know the metadata; cheap) but no PDFs flow. The
  // orchestrator uses this status to NOT count the claim toward its
  // claim_limit cap.
  if (typeof opts.minDocs === "number" && documents.length < opts.minDocs) {
    result.status = "skipped_insufficient_docs";
    return result;
  }

  // 2.6. Reconcile (daily diff of a KNOWN claim): decide incremental vs full vs
  // noop, and collect rows to soft-remove. Reuses the tree we already fetched.
  let effectiveReload = !!opts.isReload;
  let reconcileIncremental = false;
  let reconcileRemovalIntended = false;
  if (opts.reconcile && existingClaim?.id) {
    const freshDocs = documents.filter((d) => d.docId != null && d.pageCount !== 0);
    const diff = await computeTreeDiff(supabase, claimId, freshDocs);
    // Safety: never let a transient empty/failed tree wipe a populated claim.
    if (freshDocs.length === 0 && diff.storedCount > 0) {
      result.status = "reconcile_skipped_empty";
      result.reconcile_mode = "noop";
      return result;
    }
    const thresholds = opts.reconcileThresholds ?? DEFAULT_RECONCILE_THRESHOLDS;
    const mode = decideReconcileMode(diff, thresholds);
    result.reconcile_mode = mode;
    // Re-read the human-edit flag + current status + any held reconcile FRESH,
    // right before deciding — closes the TOCTOU window between the early
    // existingClaim read and here (a reviewer may have saved an edit during the
    // SOAP fetch + diff round-trips).
    const { data: freshClaim } = await supabase
      .from("claims")
      .select("synthesis_human_edited_at, synthesis_status, pending_reconcile")
      .eq("id", claimId)
      .maybeSingle();
    const humanEdited = !!freshClaim?.synthesis_human_edited_at;

    if (mode === "noop") {
      // Nothing changed. Tidy up a held/approved claim — but NEVER drop the
      // human-edit protection unless this is a genuine approved apply. A
      // scheduled noop (e.g. the held change reverted in ImageRight) must keep
      // the gate armed, or the next real change would overwrite edits unguarded.
      if (opts.approvedReconcile || freshClaim?.synthesis_status === "awaiting_approval") {
        const priorStatus = (freshClaim?.pending_reconcile as { prior_synthesis_status?: string } | null)
          ?.prior_synthesis_status ?? "completed";
        const patch: Record<string, unknown> = { pending_reconcile: null, synthesis_status: priorStatus };
        if (opts.approvedReconcile) {
          patch.synthesis_human_edited_at = null;
          patch.synthesis_human_edited_by = null;
        }
        await supabase.from("claims").update(patch).eq("id", claimId);
      }
      return result; // status stays "succeeded"
    }

    const rank = (m: ReconcileMode | undefined): number => (m === "full" ? 2 : m === "incremental" ? 1 : 0);
    // HOLD for (re-)approval when: a human edited this claim and this isn't an
    // approved apply; OR this IS an approved apply but the change has GROWN more
    // destructive than the reviewer approved (e.g. approved "update", now "full").
    // (approvedMode != null guard: a mode-less held row must not auto-escalate.)
    const escalated = opts.approvedReconcile === true && opts.approvedMode != null && rank(mode) > rank(opts.approvedMode);
    const mustHold = (humanEdited && !opts.approvedReconcile) || escalated;

    if (mustHold) {
      const nameOf = (docId: number): string => {
        const d = documents.find((x) => x.docId === docId);
        return d ? (d.description?.trim() || d.documentType?.trim() || `ir-doc-${docId}`) : `ir-doc-${docId}`;
      };
      // Preserve the pre-hold synthesis_status so a later dismiss restores it
      // (don't clobber a failed/skipped/not_run claim to 'completed'). On a
      // re-hold (already awaiting_approval), keep the originally captured status.
      const existingPrior = (freshClaim?.pending_reconcile as { prior_synthesis_status?: string } | null)
        ?.prior_synthesis_status;
      const priorStatus = freshClaim?.synthesis_status && freshClaim.synthesis_status !== "awaiting_approval"
        ? freshClaim.synthesis_status
        : (existingPrior ?? "completed");
      await supabase
        .from("claims")
        .update({
          synthesis_status: "awaiting_approval",
          pending_reconcile: {
            mode, // 'incremental' = "update", 'full' = "reprocess"
            diff: {
              added: diff.added.map((id) => ({ docId: id, name: nameOf(id) })),
              modified: diff.modified.map((id) => ({ docId: id, name: nameOf(id) })),
              removedCount: diff.removed.length,
              folderChanged: diff.folderChanged,
              storedCount: diff.storedCount,
              freshCount: diff.freshCount,
            },
            detected_at: new Date().toISOString(),
            prior_synthesis_status: priorStatus,
            escalated, // true => the change grew since the reviewer last approved
          },
        })
        .eq("id", claimId);
      result.status = "reconcile_awaiting_approval";
      return result;
    }

    // Gate passed (not human-edited, or an approved apply that didn't escalate):
    // clear any held-reconcile markers so the claim returns to the normal flow.
    if (humanEdited || opts.approvedReconcile) {
      await supabase
        .from("claims")
        .update({ pending_reconcile: null, synthesis_human_edited_at: null, synthesis_human_edited_by: null })
        .eq("id", claimId);
    }

    if (mode === "full") {
      effectiveReload = true; // fall into the wipe branch below
    } else {
      reconcileIncremental = true;
      // Track removal INTENT (not just success): if soft-remove later errors we
      // must still re-fire synthesis, or the claim is stuck at 'not_run' below.
      if (diff.removed.length > 0) reconcileRemovalIntended = true;
      // Soft-remove vanished docs up-front so they're excluded from synthesis.
      await softRemoveDocs(supabase, diff.removedRowIds, thresholds.purgeStorageOnRemove, result);
      // Reset synthesis so it re-fires once the changed docs finish: the analyze
      // trigger only locks from not_run/pending, never from 'completed'.
      await supabase.from("claims").update({ synthesis_status: "not_run" }).eq("id", claimId);
    }
  } else if (opts.reconcile) {
    result.reconcile_mode = "incremental"; // brand-new claim
  }

  // 3. Reload: wipe existing docs (storage + rows) ----------------------------
  if (effectiveReload) {
    const { data: oldDocs } = await supabase
      .from("claim_documents")
      .select("id, file_url")
      .eq("claim_id", claimId);
    if (oldDocs && oldDocs.length > 0) {
      const paths: string[] = [];
      for (const d of oldDocs) {
        if (!d.file_url) continue;
        const m = String(d.file_url).match(/\/storage\/v1\/object\/public\/claim-documents\/(.+)$/);
        if (m) paths.push(decodeURIComponent(m[1]));
      }
      if (paths.length > 0) {
        const { error: rmErr } = await supabase.storage.from(STORAGE_BUCKET).remove(paths);
        if (rmErr) recordError(result, "storage_cleanup", rmErr.message, false);
      }
      await supabase.from("claim_documents").delete().eq("claim_id", claimId);
    }
    await supabase
      .from("claims")
      .update({ synthesis_status: "not_run", ai_synthesis: null, synthesized_at: null })
      .eq("id", claimId);
  }

  // 4. Per-document handling --------------------------------------------------
  for (const doc of documents) {
    if (doc.docId == null) continue;
    if (!passesFolderFilter(doc, opts.folderFilter)) {
      result.docs_filtered_out += 1;
      continue;
    }
    // Skip empty/cut shells (ImageRight reports pageCount 0). They carry no
    // renderable content, so creating a row + fetching + analyzing is pure
    // waste. A null pageCount (unknown) is NOT skipped — let the fetch decide.
    if (doc.pageCount === 0) {
      result.docs_skipped_empty = (result.docs_skipped_empty ?? 0) + 1;
      continue;
    }
    const docResult = await syncOneDocument(supabase, claimId, doc, effectiveReload, result);
    if (docResult === "skipped_unchanged") continue;
  }

  // Reconcile removal-only case: docs were soft-removed but nothing new was
  // dispatched to analyze, so the analyze pipeline won't re-fire synthesis.
  // Kick it explicitly so the removed docs drop out of the claim summary.
  if (
    reconcileIncremental &&
    reconcileRemovalIntended &&
    result.docs_with_content === 0 &&
    result.docs_pending_content === 0
  ) {
    // Removal-only incremental: nothing was dispatched to analyze, so fire
    // synthesis explicitly to move the claim off the 'not_run' we set above.
    // Keyed on INTENT (not result.docs_removed) so a soft-remove failure can't
    // strand the claim at 'not_run'.
    await maybeFireSynthesis(supabase, claimId).catch(() => {});
  }

  result.status = result.docs_pending_content > 0 && result.docs_with_content === 0
    ? "content_pending"
    : "succeeded";
  return result;
}

type DocOutcome = "uploaded" | "pending_content" | "errored" | "skipped_unchanged";

async function syncOneDocument(
  supabase: SupabaseClient,
  claimId: string,
  doc: IRTreeDocument,
  isReload: boolean,
  result: PullResult,
): Promise<DocOutcome> {
  const { data: existingDoc } = await supabase
    .from("claim_documents")
    .select("id, processing_status, imageright_last_modified, imageright_page_count")
    .eq("imageright_document_id", doc.docId)
    .maybeSingle();

  // Skip if unchanged AND already has content. Compare the modified-date with
  // tsEqual (tolerant of TIMESTAMPTZ format/timezone serialization) plus the
  // page count — a raw string compare here previously always mismatched, forcing
  // a needless re-fetch of every doc on every pull.
  const unchanged = !!existingDoc &&
    tsEqual(existingDoc.imageright_last_modified, doc.dateLastModified) &&
    (doc.pageCount == null || existingDoc.imageright_page_count === doc.pageCount);
  if (unchanged && !isReload &&
      existingDoc!.processing_status !== "pending_content") {
    return "skipped_unchanged";
  }

  // Insert / update the row in pending_content state first; the content
  // fetcher flips it to 'pending' once the PDF lands.
  const docRow = {
    claim_id: claimId,
    source: "imageright" as const,
    imageright_document_id: doc.docId,
    imageright_last_modified: doc.dateLastModified,
    file_name: defaultFileName(doc),
    document_type: doc.documentType || "imageright-import",
    processing_status: "pending_content" as const,
    processing_error: null as string | null,
    // Preserve the ImageRight hierarchy so the portal can mirror the folder tree
    // and build layered citations. (Per-page manifest is filled by the content
    // fetcher once the PDF lands.)
    imageright_folder_id: doc.parentFolderId ?? null,
    imageright_folder_name: doc.folderName ?? null,
    imageright_folder_path: buildFolderPath(doc),
    imageright_document_type_code: doc.documentTypeCode ?? null,
    imageright_document_date: normalizeTimestamp(doc.documentDate),
    imageright_page_count: doc.pageCount ?? null,
    imageright_processing_tier: tierForType(doc.documentTypeCode),
  };

  let documentId: string;
  if (existingDoc) {
    const { error } = await supabase
      .from("claim_documents")
      .update(docRow)
      .eq("id", existingDoc.id);
    if (error) {
      recordError(result, "document_update", `docId=${doc.docId} ${error.message}`, false);
      return "errored";
    }
    documentId = existingDoc.id;
    result.docs_updated += 1;
  } else {
    const { data: inserted, error } = await supabase
      .from("claim_documents")
      .insert(docRow)
      .select("id")
      .single();
    if (error || !inserted) {
      recordError(result, "document_insert", `docId=${doc.docId} ${error?.message ?? "no_row"}`, false);
      return "errored";
    }
    documentId = inserted.id;
    result.docs_created += 1;
  }

  // Kick the PDF fetch via the dedicated Edge Function. It handles storage
  // upload, row flip to 'pending', and triggers analyze on success.
  const content = await invokeFetchDocument({
    documentId,
    imageright_document_id: doc.docId,
    claimId,
    documentType: doc.documentType || "imageright-import",
    fileName: defaultFileName(doc, /* withExt */ true),
  });

  if (content.outcome === "uploaded") {
    result.docs_with_content += 1;
    // Route for analysis — staged pump (flag on) or monolith (flag off).
    // Awaited so the round-trip completes before the parent context tears down.
    await dispatchForAnalysis(supabase, documentId);
    return "uploaded";
  }

  if (content.outcome === "uploaded_multipart") {
    // Oversized doc was fetched as multiple part rows (each ≤ the upstream
    // render limit); the fetcher already dispatched the parts and superseded
    // this head row. Do NOT dispatch the head (it has no content of its own).
    result.docs_with_content += 1;
    return "uploaded";
  }

  if (content.outcome === "multipart_pending") {
    // Some parts fetched, more remain (fetcher hit its time budget). Leave the
    // head pending_content so the next pull re-fires and resumes (skipping the
    // parts already created). Not an error.
    result.docs_pending_content += 1;
    return "pending_content";
  }

  if (content.outcome === "content_unavailable") {
    await supabase
      .from("claim_documents")
      .update({ processing_error: content.message?.slice(0, 500) ?? "content_unavailable" })
      .eq("id", documentId);
    result.docs_pending_content += 1;
    return "pending_content";
  }

  recordError(result, "content_fetch", `docId=${doc.docId} ${content.message ?? "unknown"}`, true);
  result.docs_pending_content += 1;
  return "errored";
}

function defaultFileName(doc: IRTreeDocument, withExt = false): string {
  // Prefer the instance Description; when empty, fall back to the ImageRight
  // document TYPE (ObjType.Description||Name, e.g. "Report") — which mirrors
  // what the ImageRight desktop client shows for an unnamed document — and only
  // then to the "ir-doc-{id}" placeholder. (Same precedence as soap.js folderLabel.)
  const base = doc.description?.trim() || doc.documentType?.trim() || `ir-doc-${doc.docId}`;
  // Suffix the ImageRight document id so the name is UNIQUE within a claim.
  // Claims routinely hold many identically-described documents (e.g. two
  // "POLDEM - Policy Demand"); the unique name lets the AI's filename-based
  // citations resolve to exactly one document. The portal strips "[#id]" for
  // display (see pageCite.ts / DocumentTree).
  const unique = `${base} [#${doc.docId}]`;
  return withExt ? `${unique}.pdf` : unique;
}

// =====================================================================
// Helpers: invoke other edge functions via service-role authenticated fetch
// =====================================================================

interface FetchDocumentOutcome {
  // uploaded         — single PDF stored on the head row.
  // uploaded_multipart — oversized doc fetched as N part rows; head superseded,
  //                      parts dispatched by the fetcher (do NOT dispatch head).
  // multipart_pending  — fetcher created some parts but ran out of budget; head
  //                      stays pending_content so the next pull resumes it.
  outcome: "uploaded" | "uploaded_multipart" | "multipart_pending" | "content_unavailable" | "error";
  message?: string;
  documentId?: string;
  fileUrl?: string;
  fileSize?: number;
}

async function invokeFetchDocument(payload: {
  documentId: string;
  imageright_document_id: number;
  claimId: string;
  documentType: string;
  fileName: string;
}): Promise<FetchDocumentOutcome> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/fetch-imageright-document`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.success) {
      if (body.multipart) {
        return body.complete
          ? { outcome: "uploaded_multipart", documentId: body.documentId }
          : { outcome: "multipart_pending", message: `parts ${body.partsCreated ?? "?"}/${body.partsTotal ?? "?"}` };
      }
      return { outcome: "uploaded", documentId: body.documentId, fileUrl: body.fileUrl, fileSize: body.fileSize };
    }
    if (body?.error === "content_unavailable") {
      return { outcome: "content_unavailable", message: body.upstream_message ?? body.message };
    }
    return { outcome: "error", message: body?.error ?? `status=${res.status}` };
  } catch (err) {
    return { outcome: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Cheap, DB-free metadata probe for a single ImageRight file. Used by the
 * top-N-by-doc-count selection mode to learn the doc count for every
 * candidate before committing to a full pull (which would upsert claim rows
 * and trigger PDF fetches).
 *
 * Returns ONLY the values from the SOAP `GetFileTree` response. No
 * Supabase reads, no Supabase writes, no ghost claim rows. The orchestrator
 * stores the count on `imageright_sync_tasks.total_docs` itself.
 */
export interface PullMetadataResult {
  ok: boolean;
  documents_count?: number;
  claim_number?: string | null;
  attributes?: Record<string, string | null>;
  error?: { status: number; message: string; retryable: boolean };
}

export async function pullClaimMetadata(fileId: number): Promise<PullMetadataResult> {
  const ir = clientFromEnv();
  const tree = await ir.getFileTree(fileId);
  if (!tree.ok || !tree.tree) {
    return {
      ok: false,
      error: {
        status: tree.error?.status ?? 0,
        message: tree.error?.upstreamMessage ?? "unknown",
        retryable: !!tree.error?.retryableExhausted,
      },
    };
  }
  return {
    ok: true,
    documents_count: tree.tree.documents.length,
    claim_number: tree.tree.file.claimNumber ?? null,
    attributes: tree.tree.attributes,
  };
}

/**
 * Resolve an ImageRight claim number (e.g. "0000372262") to its fileId by
 * calling the proxy's search endpoint. Returns null on miss; throws on
 * transport error.
 *
 * Exposed here so the admin reload entry-point can accept claim numbers
 * without duplicating client wiring.
 */
export async function resolveFileIdByClaimNumber(claimNumber: string): Promise<number | null> {
  const ir = clientFromEnv();
  const { ok, files, error } = await ir.searchFiles({ fileNumber: claimNumber });
  if (!ok) {
    throw new Error(`searchFiles failed: status=${error?.status ?? 0} ${error?.upstreamMessage ?? ""}`);
  }
  if (files.length === 0) return null;
  // Multiple matches shouldn't happen for an exact fileNumber, but if it does
  // (e.g. FileNumber2/3 collision), prefer the first non-deleted one. The
  // proxy already passes includeDeleted=false so this is just defensive.
  return files[0].fileId;
}
