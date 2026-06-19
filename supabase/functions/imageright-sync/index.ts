// Orchestrator for ImageRight ingestion. Three entry modes:
//   - { run_type: "one_time", from, to }   — admin-triggered bulk load
//   - { run_type: "daily_diff" }            — daily schedule (or admin button)
//   - { continuation: true, run_id }        — self-reschedule mid-run
//
// Each invocation does a bounded slice of work and, if more remains, kicks
// the next continuation via EdgeRuntime.waitUntil. This keeps every single
// request under the Supabase edge gateway's 150-second IDLE_TIMEOUT — long
// runs are completed by a chain of short invocations rather than one long
// one. See feedback_imageright_sync_gateway.md for the why.
//
// No JWT required — config.toml marks this function verify_jwt=false.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { clientFromEnv } from "../_shared/imageright-client.ts";
import {
  pullClaim,
  pullClaimMetadata,
  loadReconcileThresholds,
  type ReconcileThresholds,
} from "../_shared/imageright-pull-claim.ts";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";
import { dispatchForAnalysis } from "../_shared/dispatch-analysis.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "X-Content-Type-Options": "nosniff",
};

// Tunables ----------------------------------------------------------------
//
// 90s per-invocation budget keeps us comfortably under the 150s gateway cap.
// Tasks are processed serially because each one is several proxy round-trips
// and we don't want to hammer the VPN. ~3 tasks per invocation, each ~10-30s.
const PER_INVOCATION_BUDGET_MS = 90_000;
const TASKS_PER_BATCH = 3;
// Metadata pass (top-N selection mode, pass 1) is much lighter than the
// full pull — each probe is a single getFileTree SOAP call (~1-3s including
// per-folder recursion), no PDF fetch, no Gemini, no Supabase claims/docs
// writes. We can run ~20-30 of these inside the 90s per-invocation budget
// without straining the VPN tunnel. Sizing aggressively here cuts the
// metadata-count phase from ~hours to ~minutes when the candidate pool is
// in the 1500-3000 range.
const METADATA_TASKS_PER_BATCH = 50;
// Number of metadata probes to fly concurrently within a batch. Each probe
// is a getFileTree SOAP round-trip (~1-3s nominal, up to 60s on a slow claim).
// Serial 25-at-a-time was the original throughput bottleneck — at concurrency
// 8 the batch wraps in ~6-10s instead of ~75s.
const METADATA_PROBE_CONCURRENCY = 8;
const SWEEP_PER_BATCH = 5;
// Phase D will process up to SWEEP_BATCHES_MAX batches (= SWEEP_PER_BATCH ×
// SWEEP_BATCHES_MAX docs) per run before marking pending_content_sweep_done.
// Raised from 5 to 40 (200 docs/run) so a backlog of legitimately missing
// upstream content doesn't take days to fully process. Each batch is still
// bounded by the per-invocation budget.
const SWEEP_BATCHES_MAX = 40;
const MAX_TASK_ATTEMPTS = 3;
const DAILY_LOOKBACK_HOURS = 36;

// One-time loads start at 30-day slices and recursively halve when a slice
// hits the /files/find 1000-record cap. depth=8 → up to 256 sub-slices per
// initial chunk, far more than we'd ever need (Nodak runs ~100 claims/mo).
const ONE_TIME_INITIAL_SLICE_DAYS = 30;
const RECORDS_CAP = 1000;
const MIN_SLICE_DAYS = 1;
const MAX_SLICE_DEPTH = 8;

// Watchdog: a task stuck in 'running' state longer than this is reset to
// 'queued' so the next invocation re-claims it. Covers the case where a
// previous invocation crashed mid-task (rare but possible).
const STALE_RUNNING_AGE_MS = 5 * 60 * 1000;

// Types -------------------------------------------------------------------
type RunType = "one_time" | "daily_diff" | "manual_reload";
type RunStatus = "running" | "completed" | "failed" | "partial";

interface SyncRequest {
  run_type?: RunType;
  from?: string;
  to?: string;
  continuation?: boolean;
  run_id?: string;
  // Curated-load filters (legacy, PR #88). Both optional. When set, the
  // orchestrator skips claims whose ImageRight file has < min_docs documents
  // (those that ARE pulled don't count toward claim_limit). Once claim_limit
  // "kept" claims are pulled, the run stops dispatching new tasks. Persisted
  // in imageright_sync_runs.notes as JSON so continuations pick them up.
  min_docs?: number;
  claim_limit?: number;
  // Top-N selection (this PR). When selection_mode='top_n_by_docs', the run
  // does a metadata-only pass over every candidate, then sorts by total_docs
  // DESC and full-pulls only the top N. Mutually exclusive with the legacy
  // min_docs+claim_limit gate (which selects first-N in date order).
  selection_mode?: SelectionMode;
  top_n?: number;
  // Optional doc-count band that narrows selectTopN's candidate pool to claims
  // with total_docs in [min_total_docs, max_total_docs] before top-N picks.
  // Used to target medium-doc claims where BI cases tend to live.
  min_total_docs?: number;
  max_total_docs?: number;
}

type SelectionMode = "date_order" | "top_n_by_docs";

interface CuratedFilters {
  min_docs?: number;
  claim_limit?: number;
  selection_mode?: SelectionMode;
  top_n?: number;
  min_total_docs?: number;
  max_total_docs?: number;
}

interface Slice { from: string; to: string; depth: number }

// Top-N selection phase. Only meaningful when filters.selection_mode is
// 'top_n_by_docs'; legacy date_order mode ignores this field. Values:
//   undefined / "count_metadata" — pass 1: every queued task gets a metadata
//                                  probe (no PDF fetch, no claim row write).
//                                  Transitions to "selected" once slices are
//                                  drained AND no queued tasks remain (i.e.
//                                  every candidate has been counted).
//   "selected"                   — top-N have been re-marked status='queued'
//                                  for the full-pull pass; the rest are
//                                  status='skipped'. Phase C drains normally.
type SelectionPhase = "count_metadata" | "selected";

interface SliceCursor {
  pending_slices: Slice[];
  finished_slices: Array<{ from: string; to: string; depth: number; note?: string }>;
  pending_content_sweep_done?: boolean;
  selection_phase?: SelectionPhase;
}

// Helpers -----------------------------------------------------------------

function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = new Date(from + "T00:00:00Z").getTime();
  const b = new Date(to + "T00:00:00Z").getTime();
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function halveSlice(slice: Slice): [Slice, Slice] | null {
  const width = daysBetween(slice.from, slice.to);
  if (width <= MIN_SLICE_DAYS || slice.depth >= MAX_SLICE_DEPTH) return null;
  const mid = Math.floor(width / 2);
  const start = new Date(slice.from + "T00:00:00Z");
  const midDate = new Date(start.getTime() + mid * 86400000);
  const midPrev = new Date(midDate.getTime() - 86400000);
  return [
    { from: slice.from, to: isoDay(midPrev), depth: slice.depth + 1 },
    { from: isoDay(midDate), to: slice.to, depth: slice.depth + 1 },
  ];
}

function chunkInitial(from: string, to: string, days: number): Slice[] {
  const start = new Date(from);
  const end = new Date(to);
  const slices: Slice[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const sliceEnd = new Date(cursor);
    sliceEnd.setUTCDate(sliceEnd.getUTCDate() + days - 1);
    if (sliceEnd > end) sliceEnd.setTime(end.getTime());
    slices.push({ from: isoDay(cursor), to: isoDay(sliceEnd), depth: 0 });
    cursor = new Date(sliceEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return slices;
}

async function appendRunError(
  supabase: ReturnType<typeof adminClient>,
  runId: string,
  err: { stage: string; message: string; retryable?: boolean; claim_number?: string | null; task_id?: string },
) {
  const { data } = await supabase
    .from("imageright_sync_runs")
    .select("errors")
    .eq("id", runId)
    .single();
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  errors.push({ ...err, at: new Date().toISOString() });
  await supabase.from("imageright_sync_runs").update({ errors }).eq("id", runId);
}

// Use the SOAP proxy's dateModifiedFrom/To filter for both run types.
// REST's DateCreatedFrom/To was non-deterministic in test (verified
// 2026-05-18); under SOAP the FindFilesEx fsaDateModified condition is
// stable. Semantic of "one_time" is "claims modified in this window"
// rather than "claims created in this window" — more useful for our
// pipeline since we want claims with current activity.
function filterForSlice(_runType: RunType, slice: Slice) {
  return { dateModifiedFrom: slice.from, dateModifiedTo: slice.to };
}

// =====================================================================
// Start a new run — set up cursor, insert run row, return id
// =====================================================================

async function startRun(body: SyncRequest, supabase: ReturnType<typeof adminClient>): Promise<{ runId: string; runType: RunType }> {
  const runType: RunType = body.run_type ?? "daily_diff";

  let windowFrom: string;
  let windowTo: string;
  if (runType === "one_time") {
    if (!body.from || !body.to) throw new Error("from and to required for one_time run");
    windowFrom = body.from;
    windowTo = body.to;
  } else {
    const now = new Date();
    const from = new Date(now.getTime() - DAILY_LOOKBACK_HOURS * 3600 * 1000);
    windowFrom = from.toISOString();
    windowTo = now.toISOString();
  }

  const slices: Slice[] = runType === "one_time"
    ? chunkInitial(windowFrom, windowTo, ONE_TIME_INITIAL_SLICE_DAYS)
    : [{ from: windowFrom.slice(0, 10), to: windowTo.slice(0, 10), depth: 0 }];

  const cursor: SliceCursor = { pending_slices: slices, finished_slices: [] };

  // Persist curated-load filters in notes (JSON) so continuations pick them up.
  const filters: CuratedFilters = {};
  if (typeof body.min_docs === "number" && body.min_docs > 0) filters.min_docs = body.min_docs;
  if (typeof body.claim_limit === "number" && body.claim_limit > 0) filters.claim_limit = body.claim_limit;
  if (body.selection_mode === "top_n_by_docs") {
    if (!body.top_n || body.top_n <= 0) {
      throw new Error("selection_mode=top_n_by_docs requires top_n > 0");
    }
    filters.selection_mode = "top_n_by_docs";
    filters.top_n = body.top_n;
    if (typeof body.min_total_docs === "number" && body.min_total_docs > 0) {
      filters.min_total_docs = body.min_total_docs;
    }
    if (typeof body.max_total_docs === "number" && body.max_total_docs > 0) {
      filters.max_total_docs = body.max_total_docs;
    }
  }
  const notes = Object.keys(filters).length > 0 ? `curated_filters=${JSON.stringify(filters)}` : null;

  const { data: run, error } = await supabase
    .from("imageright_sync_runs")
    .insert({
      run_type: runType,
      window_from: windowFrom,
      window_to: windowTo,
      status: "running",
      cursor,
      notes,
    })
    .select("id")
    .single();
  if (error || !run) throw new Error(`insert_run_failed: ${error?.message}`);
  return { runId: run.id, runType };
}

// Parse the curated_filters JSON out of a run row's `notes` field.
function parseCuratedFilters(notes: string | null | undefined): CuratedFilters {
  if (!notes) return {};
  const m = notes.match(/curated_filters=(\{[^}]+\})/);
  if (!m) return {};
  try {
    const parsed = JSON.parse(m[1]);
    const out: CuratedFilters = {};
    if (typeof parsed.min_docs === "number") out.min_docs = parsed.min_docs;
    if (typeof parsed.claim_limit === "number") out.claim_limit = parsed.claim_limit;
    if (parsed.selection_mode === "top_n_by_docs") out.selection_mode = "top_n_by_docs";
    if (typeof parsed.top_n === "number") out.top_n = parsed.top_n;
    if (typeof parsed.min_total_docs === "number") out.min_total_docs = parsed.min_total_docs;
    if (typeof parsed.max_total_docs === "number") out.max_total_docs = parsed.max_total_docs;
    return out;
  } catch {
    return {};
  }
}

// =====================================================================
// Phase A — Watchdog: reset stale 'running' tasks back to 'queued'
// =====================================================================

async function resetStaleTasks(runId: string, supabase: ReturnType<typeof adminClient>): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_AGE_MS).toISOString();
  const { data, error } = await supabase
    .from("imageright_sync_tasks")
    .update({ status: "queued", last_error: "[reset] stuck in running, re-queued by watchdog" })
    .eq("run_id", runId)
    .eq("status", "running")
    .lt("updated_at", cutoff)
    .select("id");
  if (error) {
    console.error("[imageright-sync] stale reset failed", error);
    return 0;
  }
  return data?.length ?? 0;
}

// =====================================================================
// Phase B — Process ONE pending slice (one searchFiles call to the proxy)
//
// Returns true if a slice was processed (caller may want to loop), false
// if no pending slices remain.
// =====================================================================

async function processNextSlice(
  runId: string,
  runType: RunType,
  supabase: ReturnType<typeof adminClient>,
): Promise<boolean> {
  const { data: runRow } = await supabase
    .from("imageright_sync_runs")
    .select("cursor, claims_found")
    .eq("id", runId)
    .single();
  const cursor = (runRow?.cursor ?? { pending_slices: [], finished_slices: [] }) as SliceCursor;
  if (cursor.pending_slices.length === 0) return false;

  const slice = cursor.pending_slices[0];
  const ir = clientFromEnv();

  // ImageRight test SOAP randomly returns {files:[]} for slices that DO have
  // claims (verified 2026-06-11: same query returns 0/773/781/784/0 across
  // 5 attempts). Retry an empty result up to 3 times before trusting it.
  let res = await ir.searchFiles(filterForSlice(runType, slice));
  let emptyRetries = 0;
  while (res.ok && res.files.length === 0 && emptyRetries < 3) {
    emptyRetries += 1;
    await new Promise((r) => setTimeout(r, 1500));
    res = await ir.searchFiles(filterForSlice(runType, slice));
  }
  if (emptyRetries > 0) {
    console.log(`[imageright-sync] slice ${slice.from}..${slice.to} empty-retry x${emptyRetries} → ${res.ok ? res.files.length : "err"} files`);
  }

  if (!res.ok) {
    const status = res.error?.status ?? 0;
    await appendRunError(supabase, runId, {
      stage: "files_search",
      message: `slice=${slice.from}..${slice.to} status=${status} ${res.error?.upstreamMessage ?? ""}`,
      retryable: !!res.error?.retryableExhausted,
    });
    cursor.finished_slices.push({ ...slice, note: `failed_status_${status}` });
    cursor.pending_slices.shift();
    await supabase.from("imageright_sync_runs").update({ cursor }).eq("id", runId);
    return true;
  }

  const files = res.files;

  // 1000-cap halving: if the result was capped AND we can still split, push
  // two halves back onto pending_slices instead of enqueuing tasks.
  if (files.length >= RECORDS_CAP) {
    const halves = halveSlice(slice);
    if (halves) {
      cursor.pending_slices.shift();
      cursor.pending_slices.unshift(halves[1]);
      cursor.pending_slices.unshift(halves[0]);
      cursor.finished_slices.push({ ...slice, note: `capped_split_depth=${slice.depth}` });
      await supabase.from("imageright_sync_runs").update({ cursor }).eq("id", runId);
      console.log(`[imageright-sync] slice ${slice.from}..${slice.to} hit cap, split into ${halves[0].from}..${halves[0].to} + ${halves[1].from}..${halves[1].to}`);
      return true;
    }
    // Can't split further. SKIP rather than enqueue: in the test env, a
    // capped response at min-slice usually means the upstream filter is
    // misbehaving and returning unfiltered garbage (verified 2026-05-18).
    // Better to record the gap than ingest 1000 bogus claims. In production
    // a real 1000-claim day would also need pagination support, which
    // ImageRight doesn't yet provide.
    await appendRunError(supabase, runId, {
      stage: "files_find_cap_exhausted",
      message: `slice=${slice.from}..${slice.to} hit 1000-record cap at min slice width; skipped to avoid enqueueing unfiltered data (depth=${slice.depth})`,
      retryable: false,
    });
    cursor.finished_slices.push({ ...slice, note: `capped_skipped_depth=${slice.depth}` });
    cursor.pending_slices.shift();
    await supabase.from("imageright_sync_runs").update({ cursor }).eq("id", runId);
    return true;
  }

  let inserted = 0;
  for (const f of files) {
    const { data: existing } = await supabase
      .from("imageright_sync_tasks")
      .select("id")
      .eq("run_id", runId)
      .eq("imageright_file_id", f.fileId)
      .maybeSingle();
    if (existing) continue;
    const { error } = await supabase
      .from("imageright_sync_tasks")
      .insert({ run_id: runId, imageright_file_id: f.fileId, status: "queued" });
    if (!error) inserted += 1;
  }

  cursor.finished_slices.push({ ...slice });
  cursor.pending_slices.shift();
  await supabase
    .from("imageright_sync_runs")
    .update({
      cursor,
      claims_found: (runRow?.claims_found ?? 0) + files.length,
    })
    .eq("id", runId);

  console.log(`[imageright-sync] slice ${slice.from}..${slice.to} → ${files.length} files (${inserted} new tasks, ${files.length - inserted} dup)`);
  return true;
}

// =====================================================================
// Phase C'  — Metadata-count pass (top_n_by_docs mode only)
//
// For each queued task, calls SOAP `GetFileTree` via pullClaimMetadata to
// learn the document count, writes total_docs on the task row, and flips
// status from 'queued' → 'metadata_counted'. NO Supabase claims/docs writes;
// NO PDF fetch; NO analyze trigger. Once every candidate has been counted
// (queued=0, slices=done), the orchestrator runs selectTopN() to mark the
// top N as 'queued' again for the full-pull pass.
// =====================================================================

async function processMetadataBatch(
  runId: string,
  supabase: ReturnType<typeof adminClient>,
  deadline: number,
): Promise<{ processed: number; remaining: boolean }> {
  const { data: batch } = await supabase
    .from("imageright_sync_tasks")
    .select("id, imageright_file_id, attempts")
    .eq("run_id", runId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(METADATA_TASKS_PER_BATCH);

  if (!batch || batch.length === 0) return { processed: 0, remaining: false };

  let processed = 0;

  async function probeOne(task: { id: string; imageright_file_id: number | string; attempts: number }): Promise<void> {
    await supabase
      .from("imageright_sync_tasks")
      .update({ status: "running", attempts: task.attempts + 1 })
      .eq("id", task.id);

    let meta;
    try {
      meta = await pullClaimMetadata(Number(task.imageright_file_id));
    } catch (err) {
      meta = { ok: false, error: { status: 0, message: err instanceof Error ? err.message : String(err), retryable: true } };
    }

    if (!meta.ok) {
      const next = task.attempts + 1 < MAX_TASK_ATTEMPTS ? "queued" : "failed";
      await supabase
        .from("imageright_sync_tasks")
        .update({ status: next, last_error: `[metadata] ${meta.error?.message ?? "unknown"}` })
        .eq("id", task.id);
      await appendRunError(supabase, runId, {
        stage: "metadata_probe",
        message: `fileId=${task.imageright_file_id} status=${meta.error?.status ?? 0} ${meta.error?.message ?? ""}`,
        retryable: !!meta.error?.retryable,
        task_id: task.id,
      });
      return;
    }

    await supabase
      .from("imageright_sync_tasks")
      .update({
        status: "metadata_counted",
        total_docs: meta.documents_count ?? 0,
        last_error: null,
      })
      .eq("id", task.id);
  }

  // Drain `batch` through a fixed-size pool of concurrent probes. Each worker
  // pulls the next task off the queue and probes it; when the queue is empty
  // (or the per-invocation deadline trips), workers exit.
  const queue = [...batch];
  async function worker(): Promise<void> {
    while (true) {
      if (Date.now() >= deadline) return;
      const task = queue.shift();
      if (!task) return;
      try {
        await probeOne(task);
      } catch (err) {
        console.error(`[imageright-sync] metadata probe worker crash on task=${task.id}`, err);
      }
      processed += 1;
    }
  }
  const workers = Array.from({ length: METADATA_PROBE_CONCURRENCY }, () => worker());
  await Promise.all(workers);
  if (queue.length > 0) {
    console.log(`[imageright-sync] metadata deadline reached, ${processed}/${batch.length} done, ${queue.length} left in batch`);
  }

  const { count: queuedCount } = await supabase
    .from("imageright_sync_tasks")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("status", "queued");
  return { processed, remaining: (queuedCount ?? 0) > 0 };
}

// =====================================================================
// Top-N selection (one-shot SQL).
//
// Picks the N rows with the highest total_docs (tie-break by
// imageright_file_id ASC for determinism), flips them back to 'queued', and
// marks everything else 'skipped'. The full-pull pass (Phase C) then drains
// the resulting N queued tasks normally.
//
// Runs ONCE per top-N run, when all slices are drained AND no queued tasks
// remain. Sets cursor.selection_phase='selected' so we don't run it twice.
// =====================================================================

async function selectTopN(
  runId: string,
  topN: number,
  supabase: ReturnType<typeof adminClient>,
  minTotalDocs?: number,
  maxTotalDocs?: number,
): Promise<{ selected: number; dropped: number; bandRejected: number }> {
  const { data: ranked } = await supabase
    .from("imageright_sync_tasks")
    .select("id, total_docs, imageright_file_id")
    .eq("run_id", runId)
    .eq("status", "metadata_counted")
    .order("total_docs", { ascending: false, nullsFirst: false })
    .order("imageright_file_id", { ascending: true });

  if (!ranked || ranked.length === 0) return { selected: 0, dropped: 0, bandRejected: 0 };

  // Split into 3 buckets: outside-band (skipped with one reason),
  // selected (top-N within band), and dropped (in-band but below top-N).
  const outOfBandIds: string[] = [];
  const inBand: typeof ranked = [];
  for (const r of ranked) {
    const tc = r.total_docs ?? 0;
    if (minTotalDocs != null && tc < minTotalDocs) { outOfBandIds.push(r.id); continue; }
    if (maxTotalDocs != null && tc > maxTotalDocs) { outOfBandIds.push(r.id); continue; }
    inBand.push(r);
  }

  const selectedIds = inBand.slice(0, topN).map((r) => r.id);
  const droppedIds = inBand.slice(topN).map((r) => r.id);

  // PostgREST `.in(...)` builds a query-string filter; with 2000+ IDs the URL
  // exceeds the gateway's request-line limit. 500-ID chunks keep us well under
  // the limit while halving the number of round-trips vs. 100.
  const CHUNK = 500;
  async function chunkUpdate(ids: string[], patch: Record<string, unknown>) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      await supabase.from("imageright_sync_tasks").update(patch).in("id", slice);
    }
  }
  if (selectedIds.length > 0) {
    await chunkUpdate(selectedIds, { status: "queued", last_error: null });
  }
  if (droppedIds.length > 0) {
    await chunkUpdate(droppedIds, { status: "skipped", last_error: "[top_n] outside top N by doc count" });
  }
  if (outOfBandIds.length > 0) {
    const reason = `[top_n] doc count outside band [${minTotalDocs ?? "*"}, ${maxTotalDocs ?? "*"}]`;
    await chunkUpdate(outOfBandIds, { status: "skipped", last_error: reason });
  }

  console.log(`[imageright-sync] selectTopN: kept ${selectedIds.length}, dropped ${droppedIds.length}, out-of-band ${outOfBandIds.length}, top_n=${topN}, band=[${minTotalDocs ?? "*"}, ${maxTotalDocs ?? "*"}]`);
  return { selected: selectedIds.length, dropped: droppedIds.length, bandRejected: outOfBandIds.length };
}

// =====================================================================
// Phase C — Process up to TASKS_PER_BATCH queued tasks
// =====================================================================

async function processTaskBatch(
  runId: string,
  supabase: ReturnType<typeof adminClient>,
  deadline: number,
  filters: CuratedFilters,
  // Daily-diff reconcile: when set, a re-pulled KNOWN claim is diffed and routed
  // to incremental/full/noop instead of a plain re-pull. Off for one-time loads.
  reconcile?: { enabled: boolean; thresholds?: ReconcileThresholds },
): Promise<{ processed: number; remaining: boolean; kept: number }> {
  // If claim_limit is set, check how many we've already kept under this run.
  // "Kept" = task.status='succeeded' (skipped_insufficient_docs maps to
  // a separate task status; see below). Stop processing further queued
  // tasks once we've hit the cap.
  let keptSoFar = 0;
  if (filters.claim_limit) {
    const { count } = await supabase
      .from("imageright_sync_tasks")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId)
      .eq("status", "succeeded");
    keptSoFar = count ?? 0;
    if (keptSoFar >= filters.claim_limit) {
      // Cap hit. Also flip any remaining queued tasks to 'cancelled' so the
      // orchestrator stops handing them out.
      await supabase
        .from("imageright_sync_tasks")
        .update({ status: "failed", last_error: "[curated] claim_limit reached" })
        .eq("run_id", runId)
        .eq("status", "queued");
      return { processed: 0, remaining: false, kept: keptSoFar };
    }
  }

  const { data: batch } = await supabase
    .from("imageright_sync_tasks")
    .select("id, imageright_file_id, attempts")
    .eq("run_id", runId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(TASKS_PER_BATCH);

  if (!batch || batch.length === 0) return { processed: 0, remaining: false, kept: keptSoFar };

  let processed = 0;
  for (const task of batch) {
    if (Date.now() >= deadline) {
      console.log(`[imageright-sync] deadline reached mid-batch (${processed}/${batch.length} done)`);
      break;
    }
    if (filters.claim_limit && keptSoFar >= filters.claim_limit) {
      console.log(`[imageright-sync] claim_limit ${filters.claim_limit} hit mid-batch (${processed}/${batch.length} done)`);
      break;
    }

    await supabase
      .from("imageright_sync_tasks")
      .update({ status: "running", attempts: task.attempts + 1 })
      .eq("id", task.id);

    let result;
    try {
      result = await pullClaim(Number(task.imageright_file_id), {
        runId,
        minDocs: filters.min_docs,
        reconcile: reconcile?.enabled,
        reconcileThresholds: reconcile?.thresholds,
      });
    } catch (err) {
      result = {
        status: "failed" as const,
        claim_id: null,
        claim_number: null,
        docs_created: 0,
        docs_updated: 0,
        docs_pending_content: 0,
        docs_with_content: 0,
        errors: [{ stage: "pull_exception", message: err instanceof Error ? err.message : String(err), retryable: true }],
      };
    }

    let taskStatus: string;
    if (result.status === "skipped_insufficient_docs") {
      // Curated-load gate: claim has < min_docs documents. Don't retry,
      // don't count toward kept. Mark distinct so we can audit later.
      taskStatus = "skipped";
    } else if (result.status === "succeeded" || result.status === "content_pending") {
      taskStatus = "succeeded";
      keptSoFar += 1;
    } else {
      taskStatus = task.attempts + 1 < MAX_TASK_ATTEMPTS ? "queued" : "failed";
    }

    const skipNote = result.status === "skipped_insufficient_docs"
      ? `[curated] skipped (${result.total_docs_in_source ?? 0} docs < min_docs ${filters.min_docs})`
      : null;

    await supabase
      .from("imageright_sync_tasks")
      .update({
        status: taskStatus,
        claim_id: result.claim_id,
        last_error: skipNote
          ?? (result.errors.length > 0 ? result.errors[result.errors.length - 1].message : null),
      })
      .eq("id", task.id);

    for (const e of result.errors) {
      await appendRunError(supabase, runId, {
        stage: e.stage,
        message: e.message,
        retryable: e.retryable,
        claim_number: result.claim_number,
        task_id: task.id,
      });
    }

    if (result.status === "succeeded" || result.status === "content_pending") {
      const { data: run } = await supabase
        .from("imageright_sync_runs")
        .select("claims_synced, documents_created, documents_pending_content")
        .eq("id", runId)
        .single();
      await supabase
        .from("imageright_sync_runs")
        .update({
          claims_synced: (run?.claims_synced ?? 0) + 1,
          documents_created: (run?.documents_created ?? 0) + result.docs_created,
          documents_pending_content: (run?.documents_pending_content ?? 0) + result.docs_pending_content,
        })
        .eq("id", runId);
    }

    processed += 1;
  }

  // Check if more queued tasks remain (and we haven't hit the cap)
  const capReached = !!(filters.claim_limit && keptSoFar >= filters.claim_limit);
  let remaining = false;
  if (!capReached) {
    const { count: remainingCount } = await supabase
      .from("imageright_sync_tasks")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId)
      .eq("status", "queued");
    remaining = (remainingCount ?? 0) > 0;
  }

  return { processed, remaining, kept: keptSoFar };
}

// =====================================================================
// Phase D — Pending-content sweep (daily_diff only)
//
// Pulls up to SWEEP_PER_BATCH pending_content docs and retries their
// content fetch. Per-batch, with a cursor flag so it only fires once it
// has gone through enough docs to mark itself done for this run.
// =====================================================================

async function processSweepBatch(runId: string, supabase: ReturnType<typeof adminClient>): Promise<{ processed: number; remaining: boolean }> {
  const { data: pending } = await supabase
    .from("claim_documents")
    .select("id, claim_id, imageright_document_id, document_type, file_name")
    .eq("processing_status", "pending_content")
    .eq("source", "imageright")
    .order("uploaded_at", { ascending: true })
    .limit(SWEEP_PER_BATCH);

  if (!pending || pending.length === 0) return { processed: 0, remaining: false };

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  let processed = 0;
  for (const doc of pending) {
    if (!doc.imageright_document_id) {
      processed += 1;
      continue;
    }
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/fetch-imageright-document`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: doc.id,
          imageright_document_id: doc.imageright_document_id,
          claimId: doc.claim_id,
          documentType: doc.document_type ?? "imageright-import",
          fileName: doc.file_name ?? `ir-doc-${doc.imageright_document_id}.pdf`,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.success) {
        // Route for analysis — staged pump (flag on) or monolith (flag off).
        // The doc is already in `pending` after fetch flipped it; if dispatch
        // fails, the imageright_redispatch_stuck_pending watchdog re-fires it.
        await dispatchForAnalysis(supabase, doc.id);
      }
      // content_unavailable: still pending; no error to record (expected state)
    } catch (err) {
      await appendRunError(supabase, runId, {
        stage: "pending_content_sweep",
        message: `docId=${doc.id} ${err instanceof Error ? err.message : err}`,
        retryable: true,
      });
    }
    processed += 1;
  }

  // Cap the sweep at SWEEP_BATCHES_MAX batches (= SWEEP_BATCHES_MAX *
  // SWEEP_PER_BATCH docs) per run before marking pending_content_sweep_done.
  // The per-invocation budget still applies — each invocation handles one
  // batch, and the run self-reschedules across multiple invocations.
  // The next daily_diff will continue chewing through anything left.
  const { data: runRow } = await supabase
    .from("imageright_sync_runs")
    .select("cursor")
    .eq("id", runId)
    .single();
  const cursor = (runRow?.cursor ?? {}) as SliceCursor & { sweep_batches_done?: number };
  const batchesDone = (cursor.sweep_batches_done ?? 0) + 1;
  const remaining = pending.length === SWEEP_PER_BATCH && batchesDone < SWEEP_BATCHES_MAX;
  if (!remaining) cursor.pending_content_sweep_done = true;
  cursor.sweep_batches_done = batchesDone;
  await supabase.from("imageright_sync_runs").update({ cursor }).eq("id", runId);

  return { processed, remaining };
}

// =====================================================================
// Phase E — Finalize if nothing left
// =====================================================================

async function finalizeIfDone(runId: string, supabase: ReturnType<typeof adminClient>): Promise<boolean> {
  const { data: run } = await supabase
    .from("imageright_sync_runs")
    .select("cursor")
    .eq("id", runId)
    .single();
  const cursor = (run?.cursor ?? { pending_slices: [], finished_slices: [] }) as SliceCursor;
  if (cursor.pending_slices.length > 0) return false;

  const { count: queued } = await supabase
    .from("imageright_sync_tasks")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("status", "queued");
  if ((queued ?? 0) > 0) return false;

  const { count: running } = await supabase
    .from("imageright_sync_tasks")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("status", "running");
  if ((running ?? 0) > 0) return false;

  const { count: failed } = await supabase
    .from("imageright_sync_tasks")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("status", "failed");

  const { count: succeeded } = await supabase
    .from("imageright_sync_tasks")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("status", "succeeded");

  const status: RunStatus = (failed ?? 0) === 0
    ? "completed"
    : (succeeded ?? 0) === 0 ? "failed" : "partial";

  await supabase
    .from("imageright_sync_runs")
    .update({ status, completed_at: new Date().toISOString() })
    .eq("id", runId);
  return true;
}

// =====================================================================
// Self-reschedule (fire-and-forget)
// =====================================================================

async function rescheduleSelf(runId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  try {
    await fetch(`${supabaseUrl}/functions/v1/imageright-sync`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ continuation: true, run_id: runId }),
    });
  } catch (err) {
    console.error("[imageright-sync] self-reschedule failed", err);
  }
}

// =====================================================================
// HTTP handler — single batch per invocation
// =====================================================================

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Scanner short-circuit (see _shared/scanner-guard.ts). imageright-sync
  // has no per-user auth (verify_jwt=false; admin-callable only via UI), so
  // the guard runs immediately after OPTIONS to avoid any DB or proxy work.
  const scannerEarly = scannerShortCircuit(req, corsHeaders);
  if (scannerEarly) return scannerEarly;

  let body: SyncRequest = {};
  try { body = await req.json(); } catch { /* empty body OK for daily_diff */ }

  const supabase = adminClient();
  const startedAt = Date.now();
  const deadline = startedAt + PER_INVOCATION_BUDGET_MS;

  // Resolve runId + runType
  let runId: string;
  let runType: RunType;
  let filters: CuratedFilters = {};
  try {
    if (body.continuation && body.run_id) {
      runId = body.run_id;
      const { data: run } = await supabase
        .from("imageright_sync_runs")
        .select("run_type, status, notes")
        .eq("id", runId)
        .single();
      if (!run) {
        return new Response(JSON.stringify({ error: "unknown_run_id" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // If a prior continuation already finalized the run, no-op.
      if (run.status !== "running") {
        return new Response(JSON.stringify({ runId, done: true, status: run.status }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      runType = run.run_type as RunType;
      filters = parseCuratedFilters(run.notes as string | null | undefined);
    } else {
      const started = await startRun(body, supabase);
      runId = started.runId;
      runType = started.runType;
      // Re-read notes so we use the canonical persisted form.
      const { data: run } = await supabase
        .from("imageright_sync_runs")
        .select("notes")
        .eq("id", runId)
        .single();
      filters = parseCuratedFilters(run?.notes as string | null | undefined);
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Daily-diff reconcile config (loaded once per invocation). Only the
  // daily_diff schedule reconciles already-known claims (incremental vs full vs
  // noop); one-time bulk loads and manual reloads pull/wipe as before.
  // Flag-gated (imageright_settings.reconcile_enabled), DEFAULT OFF — until it's
  // flipped on, the daily sync behaves exactly as before (a re-pulled known
  // claim just upserts changed docs with no diff/soft-remove). Mirrors the
  // staged_analysis_enabled rollout pattern.
  let reconcileEnabled = false;
  if (runType === "daily_diff") {
    try {
      const { data: flagRow } = await supabase
        .from("imageright_settings").select("value").eq("name", "reconcile_enabled").maybeSingle();
      reconcileEnabled = flagRow?.value === "true";
    } catch { reconcileEnabled = false; }
  }
  const reconcileOpts = {
    enabled: reconcileEnabled,
    thresholds: reconcileEnabled ? await loadReconcileThresholds(supabase) : undefined,
  };

  // Phase A — watchdog (cheap)
  const resetCount = await resetStaleTasks(runId, supabase);
  if (resetCount > 0) console.log(`[imageright-sync] watchdog reset ${resetCount} stale running tasks`);

  // Pick exactly ONE of phases B/C'/C/D this invocation, in priority order.
  // Slices first (cheap, they unblock everything else); then the task phase
  // (which branches on selection_mode + selection_phase); then sweep.
  let didWork = false;
  let moreWork = false;

  if (Date.now() < deadline) {
    const sliceProcessed = await processNextSlice(runId, runType, supabase);
    if (sliceProcessed) {
      didWork = true;
      moreWork = true; // there may be more slices or new tasks just enqueued
    }
  }

  // Task phase — branch on selection_mode.
  if (!didWork && Date.now() < deadline) {
    if (filters.selection_mode === "top_n_by_docs") {
      // Re-read the cursor for the latest selection_phase (Phase B above may
      // have just written to it, and selectTopN below also writes to it).
      const { data: runRow } = await supabase
        .from("imageright_sync_runs")
        .select("cursor")
        .eq("id", runId)
        .single();
      const cursor = (runRow?.cursor ?? { pending_slices: [], finished_slices: [] }) as SliceCursor;
      const pendingSlicesLen = cursor.pending_slices?.length ?? 0;
      const selectionPhase = cursor.selection_phase;

      if (selectionPhase !== "selected") {
        // Still in pass 1 (count_metadata). Drain queued via metadata probe.
        const metaResult = await processMetadataBatch(runId, supabase, deadline);
        if (metaResult.processed > 0) didWork = true;
        if (metaResult.remaining) moreWork = true;

        // If queued is empty AND all slices are drained, transition to
        // 'selected' by running the one-shot top-N selection. Only fires
        // when both conditions are satisfied — otherwise we'd top-N out of
        // an incomplete candidate set.
        if (!metaResult.remaining && pendingSlicesLen === 0) {
          const topN = filters.top_n ?? 100;
          const selected = await selectTopN(runId, topN, supabase, filters.min_total_docs, filters.max_total_docs);
          // Persist phase transition.
          const newCursor: SliceCursor = { ...cursor, selection_phase: "selected" };
          await supabase
            .from("imageright_sync_runs")
            .update({ cursor: newCursor })
            .eq("id", runId);
          if (selected.selected > 0) moreWork = true;
          didWork = true;
        }
      } else {
        // Pass 2: full pull of the top-N selected tasks. Pass empty filters
        // so processTaskBatch doesn't re-apply min_docs / claim_limit gates
        // (we already pre-selected exactly N at the metadata phase).
        const taskResult = await processTaskBatch(runId, supabase, deadline, {}, reconcileOpts);
        if (taskResult.processed > 0) didWork = true;
        if (taskResult.remaining) moreWork = true;
      }
    } else {
      // Legacy date_order path — unchanged.
      const taskResult = await processTaskBatch(runId, supabase, deadline, filters, reconcileOpts);
      if (taskResult.processed > 0) didWork = true;
      if (taskResult.remaining) moreWork = true;
    }
  }

  if (!didWork && runType === "daily_diff" && Date.now() < deadline) {
    const { data: runRow } = await supabase
      .from("imageright_sync_runs")
      .select("cursor")
      .eq("id", runId)
      .single();
    const cursor = (runRow?.cursor ?? {}) as SliceCursor;
    if (!cursor.pending_content_sweep_done) {
      const sweepResult = await processSweepBatch(runId, supabase);
      if (sweepResult.processed > 0) didWork = true;
      if (sweepResult.remaining) moreWork = true;
    }
  }

  // Finalization check — if nothing left in any phase, close the run.
  const done = !moreWork && await finalizeIfDone(runId, supabase);

  if (!done) {
    // Schedule continuation. waitUntil only fires after the response is sent,
    // so the next invocation starts cleanly after this one returns.
    EdgeRuntime.waitUntil(rescheduleSelf(runId));
  }

  return new Response(
    JSON.stringify({ runId, done, elapsed_ms: Date.now() - startedAt }),
    { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
