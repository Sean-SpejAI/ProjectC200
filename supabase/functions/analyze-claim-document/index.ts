import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";
import { maybeFireSynthesis } from "../_shared/fire-synthesis.ts";

// Import shared modules
import {
  AnalyzeRequest, ClaimDetails, JobProgress, corsHeaders,
  MAX_FILE_SIZE, GEMINI_FILE_API_THRESHOLD, PRO_MODEL_THRESHOLD,
  ERROR_CODES
} from '../_shared/types.ts';
import { log, logStep, logTiming, getErrorCode, arrayBufferToBase64, parseAIResponse, parseToISODate } from '../_shared/utils.ts';
import { buildPrompts } from '../_shared/prompts.ts';
import {
  uploadPdfToGeminiFiles, deleteGeminiFile,
  generateWithGeminiFile, generateWithInlineContent,
  classifyDocumentFromFile, classifyDocumentInline, pickPrimaryType,
  GeminiPart, ClassificationEntry
} from '../_shared/gemini.ts';
import { updateJobProgress, addJobLog, createProcessingJob } from '../_shared/job.ts';
import { mergeChunkResults } from '../_shared/merge.ts';
import { extractAndPersistText } from '../_shared/text-extraction.ts';
import { performGapFillExtraction } from '../_shared/gap-fill.ts';
import { validateAndAggregateResults } from '../_shared/validation.ts';
import {
  EXTRACTION_SCHEMA, getFieldsForRetry, getFieldDefinition,
  buildResponseSchema, DocumentClassification,
} from '../_shared/extraction-schema.ts';
import {
  calculateCompleteness,
  saveCompletenessScore,
  logExtractionPass,
  getFieldsForRetry as getRetryFieldsFromReport
} from '../_shared/completeness.ts';
import { runGroundingPipeline } from '../_shared/grounding.ts';
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1';
import { isStagedEnabled } from '../_shared/dispatch-analysis.ts';
import { storagePathFromFileUrl } from '../_shared/storage-path.ts';

// ============================================================================
// SUPABASE CLIENT
// ============================================================================

function getSupabaseAdmin() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing Supabase configuration');
  }
  
  return createClient(supabaseUrl, supabaseServiceKey);
}

// The summary we stub onto a doc when extraction parse-fails (see the catch
// block in performAnalysis). Kept as a constant so the finalize guard below can
// recognise and replace it.
const PARSE_FAIL_STUB = 'Unable to parse structured analysis.';

// Resolve the doc-list summary written to claim_documents.ai_summary.
//
// WHY: when Pass 1 extraction parse-fails we stub `summary` = PARSE_FAIL_STUB,
// but the enrich passes (gap-fill / self-heal) frequently RECOVER the structured
// fields afterwards — leaving a doc with real treatmentRecap / diagnosedInjuries
// but a misleading "Unable to parse" summary. `summary` is NOT a
// getFieldsForRetry target, so it is never regenerated and the stub survives to
// the UI. Derive a real one-line summary from the recovered content instead.
// Only the genuinely-empty case (nothing recovered) keeps the stub — and those
// docs are already routed to needs_review.
function summaryForDoc(a: any): string | undefined {
  const cur = typeof a?.summary === 'string' ? a.summary.trim() : '';
  if (cur && cur !== PARSE_FAIL_STUB) return a.summary;            // real summary — keep as-is
  const narrative = typeof a?.treatmentRecap?.narrative === 'string' ? a.treatmentRecap.narrative.trim() : '';
  if (narrative.length > 40) return narrative.slice(0, 800);       // best fallback: the treatment narrative
  const parts: string[] = [];
  const dx = Array.isArray(a?.diagnosedInjuries)
    ? a.diagnosedInjuries.filter((x: any) => typeof x === 'string' && x.trim())
    : [];
  if (dx.length) parts.push(`Diagnoses: ${dx.slice(0, 6).join('; ')}`);
  const prov = a?.treatmentRecap?.providerDetails;
  if (Array.isArray(prov) && prov.length) parts.push(`${prov.length} provider record(s)`);
  const prog = a?.treatmentRecap?.prognosisAssessment?.summary;
  if (typeof prog === 'string' && prog.trim()) parts.push(prog.trim().slice(0, 200));
  if (parts.length) return parts.join(' · ');
  return cur || undefined;                                          // nothing recovered → keep stub (doc is needs_review)
}

// ============================================================================
// AUTO-RESPLIT — guarantee no chunk is too big to extract within 400 s.
//
// A single extract pass (classify + Pass 1) on a very large/dense scanned PDF
// can exceed the 400 s Edge worker wall-clock and be killed (the failure mode
// seen on legacy 50-page / ~29 MB chunks). New uploads are already capped at
// ≤12 MB / ≤15 pages by the browser splitter, which is proven safe. This is the
// server-side safety net for anything that still arrives too big: split it into
// ≤12 MB / ≤15-page pieces, push each through the staged pipeline, and supersede
// the parent. Triggered PROACTIVELY (>18 MB at the extract stage — also the
// grounding cap, so the pieces become groundable) and REACTIVELY (the pump
// routes a doc that exhausts its extract attempts here instead of failing).
// ============================================================================
const RESPLIT_THRESHOLD_BYTES = 18 * 1024 * 1024; // proactive: > grounding cap → split
const RESPLIT_MAX_MB = 12;                        // mirror the browser uploader (proven safe)
const RESPLIT_MAX_PAGES = 15;
const RESPLIT_MAX_DEPTH = 3;                       // recursion guard

function sanitizeStorageName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180);
}

async function resplitDocument(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  doc: any,
  storagePath: string | undefined,
  msgId?: number,
): Promise<void> {
  const documentId = doc.id as string;
  const claimId = (doc.claim_id as string | null) ?? null;
  const parentDetails = (doc.claim_details ?? {}) as Record<string, any>;
  const depth = Number(parentDetails.resplit_depth ?? 0);
  const deleteMsg = async () => {
    if (msgId != null) { try { await supabase.rpc('analyze_stages_delete', { p_msg_id: msgId }); } catch { /* pump dead-letters */ } }
  };

  // Re-arm every child not yet in the staged pipeline. Uses the conditional
  // enqueue RPC (atomic analysis_stage NULL→extract, sends exactly ONE message)
  // so a redelivered/concurrent reconcile re-queues only the children a prior
  // partial run left un-queued — never double-queues one already in flight.
  // This is what makes a mid-loop enqueue failure self-heal on redelivery.
  const armChildren = async (): Promise<number> => {
    const { data: kids } = await supabase
      .from('claim_documents').select('id, analysis_stage')
      .filter('claim_details->>resplit_of', 'eq', documentId);
    for (const k of (kids ?? [])) {
      if (k.analysis_stage == null) {
        await supabase.rpc('analyze_stages_enqueue_if_idle', { p_document_id: k.id });
      }
    }
    return (kids ?? []).length;
  };

  // Mark the parent done — its children carry the work. CHECKED: on failure we
  // throw (the message is NOT deleted) so a redelivery reconciles, rather than
  // leaving the parent stuck 'processing' — which would make maybeFireSynthesis
  // count it as in-flight forever and deadlock the claim's synthesis.
  const supersede = async (n: number): Promise<void> => {
    const { error } = await supabase.from('claim_documents').update({
      processing_status: 'superseded',
      analysis_stage: null,
      ai_summary: `Re-split into ${n} smaller parts for processing.`,
      processing_error: null,
    }).eq('id', documentId);
    if (error) throw new Error(`resplit supersede failed: ${error.message}`);
  };

  // Idempotency / reconciliation: children already exist (redelivery, a prior
  // partial run, or a concurrent invocation) → re-arm any un-queued children,
  // supersede, drop the message. Never creates duplicates.
  const { data: existing } = await supabase
    .from('claim_documents').select('id')
    .filter('claim_details->>resplit_of', 'eq', documentId).limit(1);
  if (existing && existing.length > 0) {
    const n = await armChildren();
    await supersede(n);
    await deleteMsg();
    log('INFO', 'STAGE', `resplit doc=${documentId} reconciled existing children`);
    return;
  }

  if (!storagePath) {
    await updateDocumentStatus(documentId, 'failed', { processing_error: 'resplit: no storage path' });
    await supabase.from('claim_documents').update({ analysis_stage: null }).eq('id', documentId);
    await deleteMsg();
    return;
  }

  const buf = await downloadFromStorage(storagePath);
  const srcPdf = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  const totalPages = srcPdf.getPageCount();
  const sizeMB = (doc.file_size ?? buf.byteLength) / (1024 * 1024);

  // Can't usefully split further → flag for a human instead of failing silently.
  if (totalPages <= 1 || depth >= RESPLIT_MAX_DEPTH) {
    await updateDocumentStatus(documentId, 'needs_review', {
      processing_error: `resplit: cannot split further (pages=${totalPages}, depth=${depth}) yet too large to extract`,
    });
    await supabase.from('claim_documents').update({ analysis_stage: null }).eq('id', documentId);
    await deleteMsg();
    return;
  }

  const numPieces = Math.max(Math.ceil(sizeMB / RESPLIT_MAX_MB), Math.ceil(totalPages / RESPLIT_MAX_PAGES));
  const pagesPer = Math.ceil(totalPages / numPieces);
  const parentOrigStart = Number(parentDetails.page_start ?? 1);
  const baseName = ((doc.file_name as string) ?? 'document').replace(/\.pdf$/i, '');

  // Slice the parent's per-page manifest onto each child so per-page tree links
  // keep working after a split. The rendered pages (in PDF order) align 1:1 with
  // the source PDF pages we copy; only attach when the manifest is complete to
  // avoid mis-mapping. Entries keep their absolute `n` (Sor page number).
  const parentPages = Array.isArray(doc.sor_pages) ? (doc.sor_pages as any[]) : [];
  const renderedParentPages = parentPages.filter((p) => p && p.rendered);
  const pageManifestAligned = renderedParentPages.length === totalPages;
  const childTier = (doc.sor_processing_tier as string | null) ?? null;

  const rows: any[] = [];
  for (let i = 0; i < numPieces; i++) {
    const startIdx = i * pagesPer;
    if (startIdx >= totalPages) break;
    const endIdx = Math.min(startIdx + pagesPer, totalPages); // exclusive
    const childDoc = await PDFDocument.create();
    const pageIdxs = Array.from({ length: endIdx - startIdx }, (_, j) => startIdx + j);
    const copied = await childDoc.copyPages(srcPdf, pageIdxs);
    copied.forEach((p) => childDoc.addPage(p));
    const bytes = await childDoc.save();
    const origStart = parentOrigStart + startIdx;
    const origEnd = parentOrigStart + endIdx - 1;
    const displayName = `${baseName} · part ${i + 1} of ${numPieces} (pp. ${origStart}-${origEnd}).pdf`;
    const path = `manual/${crypto.randomUUID()}/${sanitizeStorageName(displayName)}`;
    const { error: upErr } = await supabase.storage.from('claim-documents')
      .upload(path, bytes.buffer as ArrayBuffer,
        { cacheControl: '3600', upsert: false, contentType: 'application/pdf' });
    if (upErr) throw new Error(`resplit upload failed (${displayName}): ${upErr.message}`);
    // Store the bare storage path; the bucket is private and PDFs are served via
    // the sign-claim-document edge proxy (server reads use service-role download).
    rows.push({
      claim_id: claimId,
      source: (doc.source as string) ?? 'manual',
      file_name: displayName,
      file_url: path,
      file_size: bytes.byteLength,
      mime_type: 'application/pdf',
      document_type: 'user_upload',
      processing_status: 'pending',
      // Carry the page manifest slice + tier so split children stay
      // self-describing (per-page links) and inherit the parent's processing tier.
      sor_pages: pageManifestAligned ? renderedParentPages.slice(startIdx, endIdx) : null,
      sor_processing_tier: childTier,
      claim_details: {
        original_file_name: parentDetails.original_file_name ?? doc.file_name,
        page_start: origStart,
        page_end: origEnd,
        resplit_of: documentId,
        resplit_part: i + 1,
        resplit_count: numPieces,
        resplit_depth: depth + 1,
      },
    });
  }

  // Insert all children atomically. A UNIQUE partial index on
  // (resplit_of, resplit_part) makes a concurrent duplicate resplit collide
  // HERE (Postgres 23505) instead of double-inserting; we treat that as
  // "another invocation won the race" and fall through to reconcile. Any OTHER
  // insert error is a real failure → throw so it doesn't silently lose the doc.
  const { error: insErr } = await supabase.from('claim_documents').insert(rows);
  if (insErr && (insErr as { code?: string }).code !== '23505') {
    throw new Error(`resplit insert failed: ${insErr.message}`);
  }
  if (insErr) {
    log('WARN', 'STAGE', `resplit insert conflict doc=${documentId} — another invocation won the race; reconciling`);
  }
  const n = await armChildren();          // enqueue children (idempotent, idle-only)
  await supersede(n);                     // checked; throws on failure → redelivery reconciles
  await deleteMsg();
  log('INFO', 'STAGE', `✂️ resplit doc=${documentId} → ${n} pieces (${sizeMB.toFixed(1)}MB/${totalPages}p, depth ${depth}→${depth + 1})`);
}

// Event-driven chaining: when a manual-upload document reaches a TERMINAL state,
// immediately dispatch the next pending sibling (smallest first) of the same
// claim. This keeps a large multi-chunk claim draining continuously instead of
// waiting up to ~2-5 min for the redispatch watchdog's next tick. It is strict
// 1:1 replacement — one doc out, one doc in — so steady-state in-flight stays
// at the concurrency cap with no overshoot; the watchdog remains the backstop
// (for workers that die before chaining) and enforces the actual ceiling.
// Scoped to source='manual' so the Sor path keeps its own batched pacing.
// Fire-and-forget; never throws.
async function chainNextManualSibling(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  claimId: string,
  excludeDocId: string,
): Promise<void> {
  // When the staged pipeline owns dispatch, the pump paces siblings — this
  // monolithic 1:1 chain is obsolete AND would dispatch the next sibling to the
  // MONOLITH (no `stage`), running two pipelines on one doc. Skip it entirely.
  if (await isStagedEnabled(supabase)) return;
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) return;
    const { data: next } = await supabase
      .from('claim_documents')
      .select('id')
      .eq('claim_id', claimId)
      .eq('source', 'manual')
      .eq('processing_status', 'pending')
      .neq('id', excludeDocId)
      .order('file_size', { ascending: true, nullsFirst: true })
      .limit(1);
    const nextId = (next as { id: string }[] | null)?.[0]?.id;
    if (!nextId) return;
    log('INFO', 'CHAIN', `Chaining next manual sibling ${nextId} for claim ${claimId}`);
    fetch(`${supabaseUrl}/functions/v1/analyze-claim-document`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: nextId, async: true }),
    }).catch(() => { /* watchdog backstop will re-dispatch */ });
  } catch { /* non-fatal — watchdog backstop covers this */ }
}

// ===========================================================================
// PHASE 2 — STAGED (one-pass-per-invocation) ANALYSIS PATH
// ===========================================================================
// Additive + ISOLATED: this runs ONLY when analyze-claim-document is invoked
// with a `stage` (the pgmq pump does that, gated by the staged_analysis_enabled
// flag). The monolithic background path below is left completely untouched, so
// the default behaviour and its risk profile are unchanged.
//
// Stages (each ≤ one heavy full-PDF pass; fits the 400 s worker wall-clock):
//   extract : Pass 0 classify + Pass 1 broad extraction (share one PDF prep)
//   enrich  : Pass 2 gap-fill + Pass 3 validate + Pass 4 self-heal (text-only)
//   ground  : Pass 5 Anthropic grounding + finalize (persist + synthesis + chain)
// Each stage reads the prior result from ai_analysis_raw, persists its output,
// then advances (enqueue next stage + delete this message). The pump redelivers
// (and eventually dead-letters) a stage that fails/times out.

/** Enqueue the next stage and delete the current pump message (best-effort). */
async function advanceStage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  documentId: string,
  nextStage: string | null,
  msgId?: number,
): Promise<void> {
  try {
    if (nextStage) {
      await supabase.rpc('analyze_stages_enqueue', { p_document_id: documentId, p_stage: nextStage });
    }
    if (msgId != null) {
      // public SECURITY DEFINER wrapper → pgmq.delete (pgmq/pgmq_public schemas
      // aren't exposed to PostgREST on a bare `create extension pgmq`).
      await supabase.rpc('analyze_stages_delete', { p_msg_id: msgId });
    }
  } catch (e) {
    // If we can't delete the message, the pump's visibility-timeout will
    // redeliver this stage — idempotent enough (we overwrite ai_analysis_raw).
    log('WARN', 'STAGE', `advanceStage(${documentId}->${nextStage}) bookkeeping failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function runAnalysisStage(documentId: string, stage: string, msgId?: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  log('INFO', 'STAGE', `▶ stage=${stage} doc=${documentId} msg=${msgId ?? 'none'}`);
  try {
    const { data: doc, error } = await supabase
      .from('claim_documents')
      .select('id, claim_id, source, file_name, file_url, file_size, mime_type, document_type, document_classifications, claim_details, ai_analysis_raw, analysis_stage, sor_pages, sor_processing_tier')
      .eq('id', documentId)
      .maybeSingle();
    if (error || !doc) throw new Error(`load failed: ${error?.message ?? 'not found'}`);

    // Idempotency guard: process ONLY when the message's stage matches the doc's
    // current due-stage (analyze_stages_enqueue stamps analysis_stage = the
    // enqueued stage). A redelivered/stale message — the doc already advanced
    // past this stage — is a no-op: delete it and return, so we never re-run a
    // finished stage (which would corrupt ai_analysis_raw or double-fire synthesis).
    if (doc.analysis_stage !== stage) {
      log('INFO', 'STAGE', `skip stale msg doc=${documentId} due=${doc.analysis_stage ?? 'null'} msg=${stage}`);
      if (msgId != null) {
        try { await supabase.rpc('analyze_stages_delete', { p_msg_id: msgId }); } catch { /* pump dead-letters */ }
      }
      return;
    }

    const fileUrl = (doc.file_url as string | null) ?? undefined;
    // file_url is a BARE storage path (private bucket; PR #117). Use the shared
    // helper so both bare paths ("sor/…", "manual/…") and any legacy full
    // public/sign URLs resolve. (The old /claim-documents\/(.+)/ regex returned
    // undefined for bare paths, which made performAnalysis fall through to
    // fetch(barePath) → "Invalid URL" and stalled every staged doc.)
    const storagePath = fileUrl ? storagePathFromFileUrl(fileUrl) : undefined;
    const claimDetails = (doc.claim_details ?? {}) as ClaimDetails;
    const classifications = (doc.document_classifications as DocumentClassification[] | null) ?? null;

    await updateDocumentStatus(documentId, 'processing');

    // Reactive net: the pump routes a doc that exhausted its extract attempts
    // here (instead of marking it 'failed') so it can be split and recovered.
    if (stage === 'resplit') {
      await resplitDocument(supabase, doc, storagePath, msgId);
      return;
    }

    if (stage === 'extract') {
      // Proactive net: a chunk too big to ground (and at risk of blowing the
      // 400 s extract budget) is split into ≤12 MB / ≤15-page pieces BEFORE we
      // attempt the doomed extract — fast, no wasted ~400 s attempt.
      if ((doc.file_size ?? 0) > RESPLIT_THRESHOLD_BYTES) {
        log('INFO', 'STAGE', `extract: doc=${documentId} ${(((doc.file_size ?? 0)) / 1048576).toFixed(0)}MB > ${RESPLIT_THRESHOLD_BYTES / 1048576}MB — resplitting`);
        await resplitDocument(supabase, doc, storagePath, msgId);
        return;
      }
      // Pass 0 + Pass 1 (share the PDF prep inside performAnalysis).
      const result = await performAnalysisWithProgress(
        doc.file_name ?? 'document', doc.file_size ?? 0, doc.mime_type ?? 'application/pdf',
        storagePath, fileUrl, undefined, undefined, doc.document_type ?? 'other', claimDetails, null,
      );
      const cls = (result._documentClassifications as DocumentClassification[] | undefined) ?? null;
      if (cls && cls.length > 0) {
        await supabase.from('claim_documents')
          .update({ document_classifications: cls, document_type: pickPrimaryType(cls) })
          .eq('id', documentId);
      }
      // Persist the Pass-1 result + the extracted-text structure for later stages.
      await extractAndPersistText(documentId, result, 0);
      // Type-aware depth: low-value Sor docs (declarations, statements,
      // routine correspondence) skip the enrich gap-fill AND grounding — extract
      // is enough. They still produce ai_analysis (finalized in 'ground') so they
      // feed claim synthesis, just shallower. Full-tier docs take the full path.
      const tier = (doc.sor_processing_tier as string | null) ?? 'full';
      const nextStage = tier === 'light' ? 'ground' : 'enrich';
      await supabase.from('claim_documents')
        .update({ ai_analysis_raw: result, analysis_stage: nextStage })
        .eq('id', documentId);
      await advanceStage(supabase, documentId, nextStage, msgId);
      log('INFO', 'STAGE', `✅ extract done doc=${documentId} → ${nextStage}${tier === 'light' ? ' (light tier — skip enrich+ground)' : ''}`);
      return;
    }

    if (stage === 'enrich') {
      let analysisResult: any = doc.ai_analysis_raw ?? {};
      const extractedText = await extractAndPersistText(documentId, analysisResult, 0);
      // Pass 2 — gap-fill
      const missingFields = getFieldsForRetry(analysisResult, classifications);
      if (missingFields.length > 0) {
        analysisResult = await performGapFillExtraction(analysisResult, extractedText, documentId, undefined, classifications);
      }
      // Pass 3 — validate/aggregate
      const { merged } = validateAndAggregateResults(analysisResult, {}, EXTRACTION_SCHEMA);
      analysisResult = merged;
      // Pass 4 — completeness + self-heal
      const report = calculateCompleteness(analysisResult, EXTRACTION_SCHEMA);
      await saveCompletenessScore(documentId, report.overallScore);
      if (report.recommendation === 'retry' && report.overallScore < 0.7) {
        const retryFields = getRetryFieldsFromReport(report);
        if (retryFields.length > 0) {
          const failedMap: Record<string, any> = {};
          for (const f of retryFields) failedMap[f] = null;
          const healed = await performGapFillExtraction(failedMap, extractedText, documentId, undefined, classifications);
          for (const [k, v] of Object.entries(healed)) {
            if (v !== null && v !== undefined) {
              const keys = k.split('.'); let cur = analysisResult;
              for (let i = 0; i < keys.length - 1; i++) { if (!cur[keys[i]]) cur[keys[i]] = {}; cur = cur[keys[i]]; }
              cur[keys[keys.length - 1]] = v;
            }
          }
          await saveCompletenessScore(documentId, calculateCompleteness(analysisResult, EXTRACTION_SCHEMA).overallScore);
        }
      }
      await supabase.from('claim_documents')
        .update({ ai_analysis_raw: analysisResult, analysis_stage: 'ground' })
        .eq('id', documentId);
      await advanceStage(supabase, documentId, 'ground', msgId);
      log('INFO', 'STAGE', `✅ enrich done doc=${documentId} → ground`);
      return;
    }

    if (stage === 'ground') {
      const stageStart = Date.now();
      let analysisResult: any = doc.ai_analysis_raw ?? {};
      let finalStatus: 'completed' | 'needs_review' = 'completed';
      if (analysisResult?.rawAnalysis === true || analysisResult?._partialJsonRecovery === true) {
        finalStatus = 'needs_review';
      }
      const extractedText = await extractAndPersistText(documentId, analysisResult, 0);
      // Pass 5 — grounding (own fresh 400 s budget; time-boxed inside it too).
      // SKIP for very large PDFs: grounding loads the whole file (+~33% as
      // base64) to send to Anthropic and OOMs the 256 MB worker on ~18 MB+
      // scans (this is what looped the staged-test ground stage). Extraction
      // (Pass 1-4, already persisted) is the valuable part; grounding is a
      // quality check we forgo on the extreme chunks.
      const tier = (doc.sor_processing_tier as string | null) ?? 'full';
      const groundingSkippedLight = tier === 'light';
      const groundingEnabled = Deno.env.get('ENABLE_ANTHROPIC_GROUNDING') === 'true';
      const groundingTooBig = (doc.file_size ?? 0) > 18 * 1024 * 1024;
      const groundingBudgetMs = 330_000 - (Date.now() - stageStart);
      if (groundingEnabled && groundingBudgetMs >= 5_000 && !groundingTooBig && !groundingSkippedLight) {
        try {
          const gp = runGroundingPipeline(analysisResult, extractedText, {
            documentId, classifications,
            getPdfBuffer: storagePath ? () => downloadFromStorage(storagePath) : undefined,
          });
          gp.catch(() => { /* superseded by time-box */ });
          const gr = await Promise.race([
            gp,
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('grounding_timeout')), groundingBudgetMs)),
          ]);
          analysisResult = gr.analysisResult;
          if (gr.status === 'failed' || gr.status === 'partial') finalStatus = 'needs_review';
        } catch (gErr) {
          log('ERROR', 'STAGE', `grounding skipped/failed (keeping Pass 1-4): ${gErr instanceof Error ? gErr.message : String(gErr)}`);
        }
      } else if (groundingSkippedLight) {
        log('INFO', 'STAGE', `grounding SKIPPED — light-tier doc=${documentId} (extraction-only by document type)`);
      } else if (groundingEnabled && groundingTooBig) {
        log('WARN', 'STAGE', `grounding SKIPPED — PDF ${((doc.file_size ?? 0) / 1048576).toFixed(0)}MB exceeds the 18MB grounding cap (OOM risk); persisting extraction`);
      }
      // Post-processing — MATCH the monolithic path exactly: map
      // postAccidentRecap → treatmentRecap.providerDetails, snapshot the raw
      // result BEFORE flag/recap cleaning, then clean flags + normalize recaps.
      // (The staged path previously skipped these, diverging from the monolith.)
      const claimId = (doc.claim_id as string | null) ?? null;
      analysisResult = mapPostAccidentToProviderDetails(analysisResult);
      const rawAnalysisResult = JSON.parse(JSON.stringify(analysisResult));
      analysisResult = validateAndCleanFlags(analysisResult);
      analysisResult = normalizeRecapArrays(analysisResult);
      if (claimId) {
        try { await syncClaimDetailsFromAnalysis(documentId, claimId, rawAnalysisResult); }
        catch (e) { log('WARN', 'STAGE', `claim sync failed: ${e instanceof Error ? e.message : String(e)}`); }
      }
      await updateDocumentStatus(documentId, finalStatus, {
        ai_analysis: analysisResult,
        ai_analysis_raw: rawAnalysisResult,
        ai_summary: summaryForDoc(analysisResult),
        correspondence_status: analysisResult.verification?.status || 'pending',
        // Record WHY grounding didn't run for light-tier docs (auditable; the
        // grounding pipeline sets passed/partial/failed for full-tier docs).
        ...(groundingSkippedLight ? { grounding_status: 'skipped_light' } : {}),
      });
      await supabase.from('claim_documents').update({ analysis_stage: 'done' }).eq('id', documentId);
      // Last stage: delete the message (no next stage to enqueue).
      await advanceStage(supabase, documentId, null, msgId);
      // Fire claim-level synthesis if this was the last sibling, then chain.
      if (claimId) {
        await maybeFireSynthesis(supabase, claimId);
        await chainNextManualSibling(supabase, claimId, documentId);
      }
      log('INFO', 'STAGE', `✅ ground done doc=${documentId} status=${finalStatus}`);
      return;
    }

    log('WARN', 'STAGE', `unknown stage '${stage}' for doc=${documentId}`);
  } catch (e) {
    // Leave the pump message UN-deleted → it redelivers after the visibility
    // timeout, and dead-letters (→ 'failed') after the read cap. Do NOT reset
    // processing_status to 'pending' — that would invite the monolithic
    // redispatch watchdog. Leave it 'processing'; the pump owns staged retries,
    // and both monolithic watchdogs now skip docs with analysis_stage set.
    const msg = e instanceof Error ? e.message : String(e);
    log('ERROR', 'STAGE', `stage=${stage} doc=${documentId} failed (pump will redeliver): ${msg}`);
    try {
      await supabase.from('claim_documents')
        .update({ processing_error: `stage_${stage}_error: ${msg}`.slice(0, 500) })
        .eq('id', documentId);
    } catch { /* ignore */ }
  }
}

// maybeFireSynthesis now lives in ../_shared/fire-synthesis.ts (shared with the
// reconcile path in sor-pull-claim), imported above.

// ============================================================================
// DATABASE OPERATIONS
// ============================================================================

async function updateDocumentStatus(
  documentId: string, 
  status: 'processing' | 'completed' | 'failed' | 'pending' | 'needs_review',
  data?: { ai_analysis?: unknown; ai_analysis_raw?: unknown; ai_summary?: string; processing_error?: string; correspondence_status?: string; grounding_status?: string; }
) {
  const supabase = getSupabaseAdmin();
  
  const updateData: Record<string, unknown> = {
    processing_status: status,
    ...(status === 'processing' ? { processing_started_at: new Date().toISOString() } : {}),
    ...(status === 'completed' ? { analyzed_at: new Date().toISOString() } : {}),
    ...data,
  };
  
  const { error } = await supabase.from('claim_documents').update(updateData).eq('id', documentId);
  if (error) throw error;
  
  log('INFO', 'DB_UPDATE', `✅ Document ${documentId} status updated to: ${status}`);
}

// ============================================================================
// SYNC CLAIM DETAILS FROM ANALYSIS (Server-side persistence)
// ============================================================================

async function syncClaimDetailsFromAnalysis(
  documentId: string,
  claimId: string,
  analysisResult: any
): Promise<void> {
  const supabase = getSupabaseAdmin();
  
  try {
    // === DIAGNOSTIC: Log entry with full context ===
    log('INFO', 'SYNC_CLAIM', `========== STARTING SYNC ==========`);
    log('INFO', 'SYNC_CLAIM', `Document ID: ${documentId}`);
    log('INFO', 'SYNC_CLAIM', `Claim ID: ${claimId}`);
    
    // === DIAGNOSTIC: Log raw input structure ===
    log('DEBUG', 'SYNC_CLAIM', `analysisResult type: ${typeof analysisResult}`);
    log('DEBUG', 'SYNC_CLAIM', `analysisResult is null: ${analysisResult === null}`);
    log('DEBUG', 'SYNC_CLAIM', `Raw analysis keys: ${Object.keys(analysisResult || {}).join(', ')}`);
    
    // === DIAGNOSTIC: Log all extraction paths ===
    const extractedIdentifiers = analysisResult?.extractedIdentifiers || {};
    log('DEBUG', 'SYNC_CLAIM', `Path 1 - extractedIdentifiers.claimNumber.value: "${extractedIdentifiers?.claimNumber?.value}"`);
    log('DEBUG', 'SYNC_CLAIM', `Path 2 - analysisResult.extractedClaimNumber: "${analysisResult?.extractedClaimNumber}"`);
    log('DEBUG', 'SYNC_CLAIM', `Path 3 - analysisResult.headerInfo.claimNumber: "${analysisResult?.headerInfo?.claimNumber}"`);
    
    // Extract claim number from multiple possible locations
    let extractedClaimNumber: string | null = 
      extractedIdentifiers?.claimNumber?.value ||
      analysisResult?.extractedClaimNumber ||
      analysisResult?.headerInfo?.claimNumber ||
      null;
    
    log('DEBUG', 'SYNC_CLAIM', `Raw extracted claim number: "${extractedClaimNumber}"`);
    
    // Clean up extracted value
    if (extractedClaimNumber) {
      const originalValue = extractedClaimNumber;
      extractedClaimNumber = extractedClaimNumber.replace(/\([^)]*\)/g, '').trim();
      log('DEBUG', 'SYNC_CLAIM', `After cleanup: "${originalValue}" -> "${extractedClaimNumber}"`);
      
      // Validate - reject placeholders and invalid values
      if (extractedClaimNumber.startsWith('TEMP-') || 
          extractedClaimNumber.startsWith('NDK-') ||
          extractedClaimNumber.toLowerCase().includes('not found') ||
          extractedClaimNumber.length < 5) {
        log('WARN', 'SYNC_CLAIM', `Rejecting invalid claim number: "${extractedClaimNumber}"`);
        extractedClaimNumber = null;
      }
    }
    
    log('INFO', 'SYNC_CLAIM', `Final extracted claim number: "${extractedClaimNumber}"`);
    
    // Extract claimant name - prioritize semantic format with variations
    let extractedClaimantName: string | null = null;
    const nameIdentifier = extractedIdentifiers.claimantName;
    
    if (nameIdentifier?.value) {
      extractedClaimantName = nameIdentifier.value;
      log('DEBUG', 'SYNC_CLAIM', `Claimant name from extractedIdentifiers: "${extractedClaimantName}"`);
    } else {
      const headerInfo = analysisResult?.headerInfo || {};
      const nameSource = analysisResult?.extractedClaimantName || 
                         headerInfo.claimantFullName || 
                         headerInfo.namedobGender || 
                         analysisResult?.patientName || null;
      
      if (nameSource) {
        let namePart = nameSource.split(',')[0];
        namePart = namePart.replace(/\([^)]*\)/g, '').trim();
        namePart = namePart.replace(/\s+\d{1,2}\/\d{1,2}\/\d{2,4}.*$/i, '').trim();
        namePart = namePart.replace(/\.\s*DOB.*$/i, '').trim();
        
        if (namePart && namePart.length > 2) {
          extractedClaimantName = namePart;
        }
      }
      log('DEBUG', 'SYNC_CLAIM', `Claimant name from legacy fields: "${extractedClaimantName}"`);
    }
    
    // Extract incident date
    const headerInfo = analysisResult?.headerInfo || {};
    let extractedIncidentDate: string | null = headerInfo.dateOfAccident || 
      analysisResult?.demandReview?.dateOfAccident || null;
    if (extractedIncidentDate) {
      extractedIncidentDate = parseToISODate(extractedIncidentDate.replace(/\([^)]*\)/g, '').trim());
    }
    
    // Build list of fields we'll update
    log('DEBUG', 'SYNC_CLAIM', 'Extracted values:', {
      claimNumber: extractedClaimNumber,
      claimantName: extractedClaimantName,
      incidentDate: extractedIncidentDate,
    });
    
    // === DIAGNOSTIC: Fetch and log current DB state ===
    log('INFO', 'SYNC_CLAIM', `📡 Fetching current claim record from DB...`);
    const { data: currentClaim, error: fetchError } = await supabase
      .from('claims')
      .select('claim_number, claimant_name, incident_date, incident_description, claim_type')
      .eq('id', claimId)
      .single();
    
    if (fetchError) {
      log('ERROR', 'SYNC_CLAIM', `❌ Failed to fetch current claim: ${fetchError.message}`);
      log('INFO', 'SYNC_CLAIM', `========== SYNC COMPLETE (FETCH FAILED) ==========`);
      throw fetchError;
    }
    
    if (!currentClaim) {
      log('WARN', 'SYNC_CLAIM', `⚠️ Claim ${claimId} not found in database`);
      log('INFO', 'SYNC_CLAIM', `========== SYNC COMPLETE (NOT FOUND) ==========`);
      return;
    }
    
    log('DEBUG', 'SYNC_CLAIM', `Current DB claim_number: "${currentClaim.claim_number}"`);
    log('DEBUG', 'SYNC_CLAIM', `Current DB claimant_name: "${currentClaim.claimant_name}"`);
    
    // Helper to check if value is default/empty (includes both NDK- and TEMP- prefixes)
    const isDefault = (val: string | null | undefined): boolean => {
      if (!val) return true;
      const lower = val.toLowerCase().trim();
      return lower === '' || lower === 'unknown' || lower === 'not specified' || 
             lower === 'pending' || lower.startsWith('ndk-') || lower.startsWith('temp-');
    };
    
    const claimNumberIsDefault = isDefault(currentClaim.claim_number);
    log('DEBUG', 'SYNC_CLAIM', `Current claim_number "${currentClaim.claim_number}" isDefault: ${claimNumberIsDefault}`);
    
    // Build update payload only for default values
    const updatePayload: Record<string, string> = {};
    
    // Update claim_number if we have a valid extracted value and current is a placeholder
    if (extractedClaimNumber && claimNumberIsDefault) {
      updatePayload.claim_number = extractedClaimNumber;
      log('INFO', 'SYNC_CLAIM', `✅ Will update claim_number to "${extractedClaimNumber}"`);
    } else if (!extractedClaimNumber) {
      log('INFO', 'SYNC_CLAIM', `⏭️ No valid claim number extracted, skipping claim_number update`);
    } else {
      log('INFO', 'SYNC_CLAIM', `⏭️ Skipping claim_number - current value is not a placeholder`);
    }
    
    if (extractedClaimantName && isDefault(currentClaim.claimant_name)) {
      updatePayload.claimant_name = extractedClaimantName;
      log('INFO', 'SYNC_CLAIM', `✅ Will update claimant_name to "${extractedClaimantName}"`);
    }
    
    if (extractedIncidentDate && isDefault(currentClaim.incident_date)) {
      updatePayload.incident_date = extractedIncidentDate;
      log('INFO', 'SYNC_CLAIM', `✅ Will update incident_date to "${extractedIncidentDate}"`);
    }
    
    log('INFO', 'SYNC_CLAIM', `📝 Final update payload (${Object.keys(updatePayload).length} fields): ${JSON.stringify(updatePayload)}`);
    
    if (Object.keys(updatePayload).length > 0) {
      // === DIAGNOSTIC: Log the update we're about to perform ===
      log('INFO', 'SYNC_CLAIM', `💾 Executing UPDATE...`);
      log('DEBUG', 'SYNC_CLAIM', `UPDATE claims SET ${Object.keys(updatePayload).map(k => `${k} = "${updatePayload[k]}"`).join(', ')} WHERE id = "${claimId}"`);
      
      // Perform the update
      const { data: updateResult, error: updateError } = await supabase
        .from('claims')
        .update(updatePayload)
        .eq('id', claimId)
        .select('claim_number, claimant_name');
      
      if (updateError) {
        log('ERROR', 'SYNC_CLAIM', `❌ Update failed: ${updateError.message}`);
        log('ERROR', 'SYNC_CLAIM', `Error code: ${updateError.code}`);
        log('ERROR', 'SYNC_CLAIM', `Error details: ${JSON.stringify(updateError.details)}`);
        log('INFO', 'SYNC_CLAIM', `========== SYNC COMPLETE (UPDATE FAILED) ==========`);
        throw updateError;
      }
      
      // === DIAGNOSTIC: Verify the update worked ===
      log('DEBUG', 'SYNC_CLAIM', `Update result: ${JSON.stringify(updateResult)}`);
      
      const { data: verifyData } = await supabase
        .from('claims')
        .select('claim_number, claimant_name')
        .eq('id', claimId)
        .single();
      
      log('INFO', 'SYNC_CLAIM', `✅ Verification - DB now has claim_number: "${verifyData?.claim_number}", claimant_name: "${verifyData?.claimant_name}"`);
      log('INFO', 'SYNC_CLAIM', `========== SYNC COMPLETE (SUCCESS) ==========`);
    } else {
      log('INFO', 'SYNC_CLAIM', '⏭️ No updates needed - all values already populated or no valid extracted data');
      log('INFO', 'SYNC_CLAIM', `========== SYNC COMPLETE (NO UPDATE) ==========`);
    }
  } catch (err) {
    // === DIAGNOSTIC: Full error capture ===
    log('ERROR', 'SYNC_CLAIM', `❌ EXCEPTION in syncClaimDetailsFromAnalysis`);
    log('ERROR', 'SYNC_CLAIM', `Error type: ${err?.constructor?.name}`);
    log('ERROR', 'SYNC_CLAIM', `Error message: ${err instanceof Error ? err.message : String(err)}`);
    log('ERROR', 'SYNC_CLAIM', `Error stack: ${err instanceof Error ? err.stack : 'N/A'}`);
    log('INFO', 'SYNC_CLAIM', `========== SYNC COMPLETE (FAILED) ==========`);
    
    // Re-throw to ensure caller knows sync failed
    throw err;
  }
}

// ============================================================================
// POST-PROCESSING: VALIDATE AND CLEAN CONTRADICTORY FLAGS
// ============================================================================

function isValidExtractedValue(value: unknown): boolean {
  if (!value) return false;
  
  // Handle arrays - check if non-empty with valid entries
  if (Array.isArray(value)) {
    return value.length > 0 && value.some(item => {
      if (typeof item === 'object' && item !== null) {
        // Check if the object has meaningful content
        const values = Object.values(item).filter(v => v !== null && v !== undefined && v !== '');
        return values.length > 0;
      }
      return item !== null && item !== undefined && item !== '';
    });
  }
  
  // Handle string values
  const str = String(value).toLowerCase().trim();
  return str !== '' && 
         str.length > 2 &&
         !str.includes('not found') && 
         !str.includes('unknown') &&
         !str.includes('not specified') &&
         !str.includes('not documented') &&
         !str.includes('searched');
}

function validateAndCleanFlags(analysisResult: any): any {
  log('INFO', 'VALIDATE', '🔍 Starting flag validation and contradiction detection...');
  
  // Build map of successfully extracted data from all possible sources
  // Include BOTH legacy fields AND new structured arrays
  const extractedData: Record<string, unknown> = {
    // Core identifiers
    dateOfBirth: analysisResult.extractedIdentifiers?.dateOfBirth?.value || 
                 analysisResult.extractedDateOfBirth ||
                 analysisResult.headerInfo?.dateOfBirth,
    gender: analysisResult.extractedIdentifiers?.gender?.value ||
            analysisResult.extractedGender ||
            analysisResult.headerInfo?.gender,
    claimantName: analysisResult.extractedIdentifiers?.claimantName?.value ||
                  analysisResult.extractedClaimantName ||
                  analysisResult.headerInfo?.claimantFullName,
    claimNumber: analysisResult.extractedIdentifiers?.claimNumber?.value ||
                 analysisResult.extractedClaimNumber ||
                 analysisResult.headerInfo?.claimNumber,
    dateOfLoss: analysisResult.extractedIdentifiers?.dateOfLoss?.value ||
                analysisResult.headerInfo?.dateOfAccident,
    
    // NEW: Settlement/Demand fields
    demandAmount: analysisResult.headerInfo?.demandAmount,
    
    // NEW: Medical/Imaging fields - check both treatmentRecap and direct arrays
    imagingResults: analysisResult.treatmentRecap?.imagingResults || [],
    
    // NEW: Provider/Treatment fields - check multiple sources
    providerDetails: analysisResult.treatmentRecap?.providerDetails || [],
    postAccidentRecap: analysisResult.postAccidentRecap || [],
    
    // NEW: Billing fields
    medicalBillBreakdown: analysisResult.medicalBillBreakdown || [],
    
    // NEW: Injury fields
    diagnosedInjuries: analysisResult.diagnosedInjuries || []
  };
  
  // Log extracted data summary for debugging
  log('INFO', 'VALIDATE', '📊 Successfully extracted data summary:');
  log('INFO', 'VALIDATE', `   - demandAmount: ${extractedData.demandAmount ? `YES ("${String(extractedData.demandAmount).substring(0, 50)}...")` : 'NO'}`);
  log('INFO', 'VALIDATE', `   - imagingResults: ${isValidExtractedValue(extractedData.imagingResults) ? `YES (${(extractedData.imagingResults as any[]).length} items)` : 'NO'}`);
  log('INFO', 'VALIDATE', `   - providerDetails: ${isValidExtractedValue(extractedData.providerDetails) ? `YES (${(extractedData.providerDetails as any[]).length} items)` : 'NO'}`);
  log('INFO', 'VALIDATE', `   - postAccidentRecap: ${isValidExtractedValue(extractedData.postAccidentRecap) ? `YES (${(extractedData.postAccidentRecap as any[]).length} items)` : 'NO'}`);
  log('INFO', 'VALIDATE', `   - medicalBillBreakdown: ${isValidExtractedValue(extractedData.medicalBillBreakdown) ? `YES (${(extractedData.medicalBillBreakdown as any[]).length} items)` : 'NO'}`);
  log('INFO', 'VALIDATE', `   - diagnosedInjuries: ${isValidExtractedValue(extractedData.diagnosedInjuries) ? `YES (${(extractedData.diagnosedInjuries as any[]).length} items)` : 'NO'}`);
  log('INFO', 'VALIDATE', `   - dateOfBirth: ${extractedData.dateOfBirth ? 'YES' : 'NO'}`);
  log('INFO', 'VALIDATE', `   - gender: ${extractedData.gender ? 'YES' : 'NO'}`);
  log('INFO', 'VALIDATE', `   - claimantName: ${extractedData.claimantName ? 'YES' : 'NO'}`);
  log('INFO', 'VALIDATE', `   - claimNumber: ${extractedData.claimNumber ? 'YES' : 'NO'}`);
  log('INFO', 'VALIDATE', `   - dateOfLoss: ${extractedData.dateOfLoss ? 'YES' : 'NO'}`);
  
  // Define contradiction patterns - EXPANDED to cover all major extraction fields
  const contradictionPatterns = [
    // Core identifiers
    { field: 'dateOfBirth', patterns: ['dob', 'date of birth', 'birthdate', 'birth date', 'd.o.b'] },
    { field: 'gender', patterns: ['gender', 'sex'] },
    { field: 'claimantName', patterns: ['claimant name', 'patient name', 'claimant', 'patient'] },
    { field: 'claimNumber', patterns: ['claim number', 'claim no', 'claim #'] },
    { field: 'dateOfLoss', patterns: ['date of loss', 'dol', 'accident date', 'date of accident'] },
    
    // NEW: Settlement/Demand patterns
    { field: 'demandAmount', patterns: ['demand amount', 'settlement amount', 'demand letter', 'settlement', 'policy limits', 'demand'] },
    
    // NEW: Medical/Imaging patterns - covers radiology findings
    { field: 'imagingResults', patterns: ['radiology', 'imaging', 'x-ray', 'xray', 'ct scan', 'ct ', 'mri', 'findings', 'radiology report', 'imaging study', 'diagnostic imaging'] },
    
    // NEW: Provider/Treatment patterns
    { field: 'providerDetails', patterns: ['provider', 'treatment record', 'medical record', 'physician', 'doctor', 'hospital', 'clinic'] },
    { field: 'postAccidentRecap', patterns: ['treatment', 'medical treatment', 'care', 'therapy', 'chiropractic', 'physical therapy'] },
    
    // NEW: Billing patterns
    { field: 'medicalBillBreakdown', patterns: ['itemized bill', 'medical bill', 'billing', 'charges', 'medical expense'] },
    
    // NEW: Injury patterns
    { field: 'diagnosedInjuries', patterns: ['diagnosed injuries', 'injuries', 'diagnosis', 'diagnoses'] }
  ];
  
  // EXPANDED: Comprehensive list of phrases indicating something is missing/absent
  const negativeIndicators = [
    // Original patterns
    'not found', 'missing', 'unavailable', 'not provided', 
    'not documented', 'not present', 'not specified', 'unable to find',
    'could not locate', 'no evidence of', 'absent',
    
    // NEW: Critical additions to catch more contradiction phrasings
    'not included',          // "radiology reports...are not included"
    'no explicit',           // "No explicit demand letter"
    'is not available',      // Common phrasing
    'are not available',     // Common phrasing  
    'only billing',          // "only billing descriptions available" (implies incomplete)
    'only available',        // "only X available" (implies missing the main data)
    'without findings',      // "imaging without findings"
    'lacking',               // "lacking detail"
    'lack of',               // "lack of radiology"
    'incomplete',            // "incomplete records"
    'not complete',          // "records not complete"
    'no specific',           // "no specific details"
    'only a general',        // "only a general statement"
    'only referenced',       // "only referenced but not included"
    'not explicitly',        // "not explicitly documented"
    'not attached',          // "records not attached"
    'is not present',        // "demand is not present"
    'are not present',       // "reports are not present"
    'not available',         // General "not available"
    'no detailed',           // "no detailed radiology"
    'no full',               // "no full records"
    'only summary'           // "only summary available"
  ];
  
  const requestIndicators = [
    'request', 'obtain', 'verify', 'confirm', 'clarify', 'need'
  ];
  
  let flagsRemoved = 0;
  let actionsRemoved = 0;
  
  // Filter flags array
  // Filter flags array with detailed logging
  if (analysisResult.flags && Array.isArray(analysisResult.flags)) {
    const originalCount = analysisResult.flags.length;
    log('INFO', 'VALIDATE', `🏷️ Processing ${originalCount} flags for contradictions...`);
    
    analysisResult.flags = analysisResult.flags.filter((flag: string) => {
      if (typeof flag !== 'string') return true;
      const flagLower = flag.toLowerCase();
      
      for (const { field, patterns } of contradictionPatterns) {
        if (extractedData[field] && isValidExtractedValue(extractedData[field])) {
          // Check if flag mentions this field AND indicates it's missing
          const mentionsField = patterns.some(p => flagLower.includes(p));
          const matchedNegative = negativeIndicators.find(n => flagLower.includes(n));
          const indicatesMissing = !!matchedNegative;
          
          // Log detailed match info for debugging
          if (mentionsField) {
            const matchedPattern = patterns.find(p => flagLower.includes(p));
            log('DEBUG', 'VALIDATE', `Flag check: "${flag.substring(0, 60)}..." → mentions ${field} (pattern: "${matchedPattern}"), indicatesMissing: ${indicatesMissing}${matchedNegative ? ` (matched: "${matchedNegative}")` : ''}`);
          }
          
          if (mentionsField && indicatesMissing) {
            log('INFO', 'VALIDATE', `🗑️ Removing contradictory flag: "${flag.substring(0, 80)}..." (${field} was successfully extracted)`);
            return false; // Remove this flag
          }
        }
      }
      return true; // Keep this flag
    });
    flagsRemoved = originalCount - analysisResult.flags.length;
  }
  
  // Filter recommendedActions array with detailed logging
  if (analysisResult.recommendedActions && Array.isArray(analysisResult.recommendedActions)) {
    const originalCount = analysisResult.recommendedActions.length;
    log('INFO', 'VALIDATE', `📋 Processing ${originalCount} recommended actions for contradictions...`);
    
    analysisResult.recommendedActions = analysisResult.recommendedActions.filter((action: string) => {
      if (typeof action !== 'string') return true;
      const actionLower = action.toLowerCase();
      
      for (const { field, patterns } of contradictionPatterns) {
        if (extractedData[field] && isValidExtractedValue(extractedData[field])) {
          const mentionsField = patterns.some(p => actionLower.includes(p));
          const indicatesRequest = requestIndicators.some(r => actionLower.includes(r));
          const matchedNegative = negativeIndicators.find(n => actionLower.includes(n));
          const indicatesMissing = !!matchedNegative;
          
          // Log detailed match info for debugging
          if (mentionsField && (indicatesRequest || indicatesMissing)) {
            const matchedPattern = patterns.find(p => actionLower.includes(p));
            log('INFO', 'VALIDATE', `🗑️ Removing contradictory action: "${action.substring(0, 80)}..." (${field} was successfully extracted, pattern: "${matchedPattern}")`);
            return false;
          }
        }
      }
      return true;
    });
    actionsRemoved = originalCount - analysisResult.recommendedActions.length;
  }
  
  if (flagsRemoved > 0 || actionsRemoved > 0) {
    log('INFO', 'VALIDATE', `✅ Removed ${flagsRemoved} contradictory flags and ${actionsRemoved} contradictory actions`);
  } else {
    log('DEBUG', 'VALIDATE', 'No contradictory flags or actions found');
  }
  
  return analysisResult;
}

// ============================================================================
// POST-PROCESSING: NORMALIZE MALFORMED ARRAY ELEMENTS
// ============================================================================

function normalizeRecapArrays(analysisResult: any): any {
  log('DEBUG', 'NORMALIZE', 'Starting recap array normalization...');
  
  let preNormalized = 0;
  let postNormalized = 0;
  
  // Helper to normalize a single array
  const normalizeArray = (arr: any, defaultProvider: string): any[] => {
    // Handle non-array input
    if (!arr) return [];
    
    if (typeof arr === 'string') {
      log('DEBUG', 'NORMALIZE', `Converting string to array: "${arr.substring(0, 50)}..."`);
      return [{ provider: defaultProvider, summary: arr, cptCodes: [], pageRefs: "" }];
    }
    
    if (!Array.isArray(arr)) {
      log('DEBUG', 'NORMALIZE', `Unexpected type for recap array: ${typeof arr}`);
      return [];
    }
    
    return arr.map((item: any, idx: number) => {
      if (typeof item === 'string') {
        log('DEBUG', 'NORMALIZE', `Converting string element ${idx} to object: "${item.substring(0, 50)}..."`);
        return { provider: defaultProvider, summary: item, cptCodes: [], pageRefs: "" };
      }
      
      if (typeof item === 'object' && item !== null) {
        // Ensure all required properties exist with defaults
        return {
          provider: item.provider || "Unknown Provider",
          summary: item.summary || "",
          cptCodes: Array.isArray(item.cptCodes) ? item.cptCodes : [],
          pageRefs: item.pageRefs || ""
        };
      }
      
      // Skip invalid elements
      log('DEBUG', 'NORMALIZE', `Skipping invalid element at index ${idx}: ${typeof item}`);
      return null;
    }).filter(Boolean);
  };
  
  // Normalize preAccidentRecap
  if (analysisResult.preAccidentRecap !== undefined) {
    const before = JSON.stringify(analysisResult.preAccidentRecap);
    analysisResult.preAccidentRecap = normalizeArray(
      analysisResult.preAccidentRecap, 
      "Pre-Accident History"
    );
    const after = JSON.stringify(analysisResult.preAccidentRecap);
    if (before !== after) {
      preNormalized = analysisResult.preAccidentRecap.length;
      log('DEBUG', 'NORMALIZE', `preAccidentRecap normalized: ${preNormalized} entries`);
    }
  }
  
  // Normalize postAccidentRecap
  if (analysisResult.postAccidentRecap !== undefined) {
    const before = JSON.stringify(analysisResult.postAccidentRecap);
    analysisResult.postAccidentRecap = normalizeArray(
      analysisResult.postAccidentRecap,
      "Unknown Provider"
    );
    const after = JSON.stringify(analysisResult.postAccidentRecap);
    if (before !== after) {
      postNormalized = analysisResult.postAccidentRecap.length;
      log('DEBUG', 'NORMALIZE', `postAccidentRecap normalized: ${postNormalized} entries`);
    }
  }
  
  if (preNormalized > 0 || postNormalized > 0) {
    log('INFO', 'NORMALIZE', `✅ Normalized recap arrays - pre: ${preNormalized}, post: ${postNormalized}`);
  } else {
    log('DEBUG', 'NORMALIZE', 'No recap array normalization needed');
  }
  
  return analysisResult;
}

// ============================================================================
// POST-PROCESSING: MAP postAccidentRecap TO treatmentRecap.providerDetails
// ============================================================================

/**
 * Maps postAccidentRecap[] to treatmentRecap.providerDetails[] for UI compatibility.
 * The AI correctly extracts provider data into postAccidentRecap, but the UI expects
 * it in treatmentRecap.providerDetails.
 */
function mapPostAccidentToProviderDetails(analysisResult: any): any {
  log('DEBUG', 'DATA_MAP', 'Starting postAccidentRecap to providerDetails mapping...');
  
  // Check if we have postAccidentRecap data
  const hasPostAccidentRecap = analysisResult.postAccidentRecap && 
                               Array.isArray(analysisResult.postAccidentRecap) && 
                               analysisResult.postAccidentRecap.length > 0;
  
  // Check if providerDetails is already populated
  const hasProviderDetails = analysisResult.treatmentRecap?.providerDetails && 
                             Array.isArray(analysisResult.treatmentRecap.providerDetails) && 
                             analysisResult.treatmentRecap.providerDetails.length > 0;
  
  if (!hasPostAccidentRecap) {
    log('DEBUG', 'DATA_MAP', 'No postAccidentRecap data to map');
    return analysisResult;
  }
  
  if (hasProviderDetails) {
    log('DEBUG', 'DATA_MAP', `providerDetails already populated (${analysisResult.treatmentRecap.providerDetails.length} entries), skipping mapping`);
    return analysisResult;
  }
  
  log('INFO', 'DATA_MAP', `Mapping ${analysisResult.postAccidentRecap.length} postAccidentRecap entries to providerDetails`);
  
  // Transform postAccidentRecap format to providerDetails format
  const providerDetails = analysisResult.postAccidentRecap.map((recap: any, index: number) => {
    // Extract date range from summary if available
    let dateRange = '';
    const summary = recap.summary || '';
    
    // Try to extract dates from summary (common patterns)
    const dateMatch = summary.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-–to]+\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (dateMatch) {
      dateRange = `${dateMatch[1]} - ${dateMatch[2]}`;
    } else {
      // Try single date
      const singleDateMatch = summary.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      if (singleDateMatch) {
        dateRange = singleDateMatch[1];
      }
    }
    
    // Extract visit count from summary if available
    let visits = '';
    const visitMatch = summary.match(/(\d+)\s*(?:visit|appointment|session|treatment)/i);
    if (visitMatch) {
      visits = visitMatch[1];
    }
    
    // Determine specialty from provider name or summary
    let specialty = 'See summary';
    const providerLower = (recap.provider || '').toLowerCase();
    const summaryLower = summary.toLowerCase();
    
    if (providerLower.includes('hospital') || providerLower.includes('emergency') || summaryLower.includes('emergency')) {
      specialty = 'Emergency';
    } else if (providerLower.includes('chiro') || summaryLower.includes('chiro')) {
      specialty = 'Chiropractic';
    } else if (providerLower.includes('physical therapy') || providerLower.includes('pt ') || summaryLower.includes('physical therapy')) {
      specialty = 'Physical Therapy';
    } else if (providerLower.includes('radiology') || providerLower.includes('imaging') || summaryLower.includes('mri') || summaryLower.includes('x-ray') || summaryLower.includes('ct scan')) {
      specialty = 'Radiology';
    } else if (providerLower.includes('orthopedic') || summaryLower.includes('orthopedic')) {
      specialty = 'Orthopedic';
    } else if (providerLower.includes('pain') || summaryLower.includes('pain management')) {
      specialty = 'Pain Management';
    } else if (providerLower.includes('neuro') || summaryLower.includes('neuro')) {
      specialty = 'Neurology';
    }
    
    const mapped = {
      name: recap.provider || `Provider ${index + 1}`,
      specialty,
      dateRange,
      visits,
      treatmentsProvided: recap.cptCodes || [],
      pageRefs: recap.pageRefs || ''
    };
    
    log('DEBUG', 'DATA_MAP', `Mapped provider: ${mapped.name} (${specialty})`);
    return mapped;
  });
  
  // Build narrative from postAccidentRecap summaries
  const narrative = analysisResult.postAccidentRecap
    .map((r: any) => `**${r.provider || 'Unknown Provider'}**: ${r.summary || 'No summary available'}`)
    .join('\n\n');
  
  // Initialize treatmentRecap if it doesn't exist
  if (!analysisResult.treatmentRecap) {
    analysisResult.treatmentRecap = {};
  }
  
  // Populate providerDetails and narrative
  analysisResult.treatmentRecap.providerDetails = providerDetails;
  
  // Only set narrative if it's empty
  if (!analysisResult.treatmentRecap.narrative || analysisResult.treatmentRecap.narrative.length < 50) {
    analysisResult.treatmentRecap.narrative = narrative;
    log('INFO', 'DATA_MAP', `Set narrative from ${providerDetails.length} providers`);
  }
  
  log('INFO', 'DATA_MAP', `✅ Successfully mapped ${providerDetails.length} providers to treatmentRecap.providerDetails`);
  
  return analysisResult;
}

async function loadDocumentFromDatabase(documentId: string) {
  const supabase = getSupabaseAdmin();
  
  const { data: doc, error } = await supabase
    .from('claim_documents')
    .select(`*, claims (claim_number, claim_type, incident_date, incident_description, claimant_name, accident_location)`)
    .eq('id', documentId)
    .single();
    
  if (error || !doc) throw new Error(`Document not found: ${documentId}`);
  
  log('INFO', 'DB_LOAD', `✅ Document loaded: ${doc.file_name}`);
  return doc;
}

// ============================================================================
// STORAGE OPERATIONS
// ============================================================================

async function downloadFromStorage(storagePath: string): Promise<ArrayBuffer> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage.from('claim-documents').download(storagePath);
  
  if (error) throw new Error(`Storage download failed: ${error.message}`);
  
  const arrayBuffer = await data.arrayBuffer();
  log('INFO', 'STORAGE', `✅ Downloaded file: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
  return arrayBuffer;
}

// ============================================================================
// MAIN ANALYSIS LOGIC
// ============================================================================

async function performAnalysis(
  fileName: string,
  fileSize: number,
  mimeType: string,
  storagePath: string | undefined,
  fileUrl: string | undefined,
  fileBase64: string | undefined,
  documentContent: string | undefined,
  documentType: string,
  claimDetails: ClaimDetails
) {
  const totalStartTime = Date.now();
  const TOTAL_STEPS = 6;
  
  log('INFO', 'ANALYSIS', '🚀 STARTING DOCUMENT ANALYSIS');
  log('INFO', 'ANALYSIS', 'Input parameters', { fileName, fileSizeMB: `${(fileSize / 1024 / 1024).toFixed(2)} MB`, mimeType });
  
  const HAS_GEMINI = !!Deno.env.get('GEMINI_API_KEY');
  if (!HAS_GEMINI) throw new Error('GEMINI_API_KEY is not configured');

  const isPdfType = mimeType === 'application/pdf' || fileName?.toLowerCase().endsWith('.pdf');
  const isImageType = mimeType?.startsWith('image/') || fileName?.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp|bmp)$/);

  let processingMode = 'text';
  let pdfBase64: string | null = null;
  let geminiFileName: string | null = null;
  let geminiFileUri: string | null = null;
  let fileBuffer: ArrayBuffer | null = null;

  // Step 1: Download file if needed
  logStep(1, TOTAL_STEPS, 'ANALYSIS', 'Downloading file from storage');

  if (storagePath) {
    fileBuffer = await downloadFromStorage(storagePath);
    fileSize = fileBuffer.byteLength;
  }

  if (fileSize > MAX_FILE_SIZE) {
    throw new Error(`File size (${(fileSize / 1024 / 1024).toFixed(0)} MB) exceeds maximum allowed size (${MAX_FILE_SIZE / 1024 / 1024} MB)`);
  }

  // Step 2: Determine processing mode
  logStep(2, TOTAL_STEPS, 'ANALYSIS', 'Determining processing mode');

  if (isPdfType) {
    if (fileSize > GEMINI_FILE_API_THRESHOLD && HAS_GEMINI) {
      log('INFO', 'ANALYSIS', '📤 Using Gemini Files API for large PDF');
      processingMode = 'gemini-file';

      if (!fileBuffer && fileUrl) {
        // Bucket is private — download via service role (never fetch a public URL).
        fileBuffer = await downloadFromStorage(storagePathFromFileUrl(fileUrl));
      } else if (!fileBuffer && fileBase64) {
        const binaryString = atob(fileBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
        fileBuffer = bytes.buffer;
      }
      if (!fileBuffer) {
        throw new Error('Oversize PDF requires storagePath, fileUrl, or fileBase64 — none provided.');
      }

      logStep(3, TOTAL_STEPS, 'ANALYSIS', 'Uploading PDF to Gemini Files API');
      const uploaded = await uploadPdfToGeminiFiles(fileBuffer, fileName.replace(/[^a-zA-Z0-9._-]/g, '_'));
      geminiFileName = uploaded.name;
      geminiFileUri = uploaded.uri;
    } else if (HAS_GEMINI || fileSize <= GEMINI_FILE_API_THRESHOLD) {
      log('INFO', 'ANALYSIS', '📄 Using inline PDF');
      processingMode = 'pdf-inline';
      
      if (!fileBuffer && storagePath) {
        fileBuffer = await downloadFromStorage(storagePath);
      } else if (!fileBuffer && fileUrl) {
        const response = await fetch(fileUrl);
        fileBuffer = await response.arrayBuffer();
      } else if (!fileBuffer && fileBase64) {
        const binaryString = atob(fileBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        fileBuffer = bytes.buffer;
      }
      
      if (fileBuffer) {
        pdfBase64 = arrayBufferToBase64(fileBuffer);
      }
    } else {
      processingMode = 'text-fallback';
    }
  } else if (isImageType) {
    processingMode = 'vision-url';
  }

  log('INFO', 'ANALYSIS', `Processing mode selected: ${processingMode}`);

  // -------------------------------------------------------------------------
  // Pass 0 — Document classification (Phase 1.1)
  //
  // Runs BEFORE Pass 1 so the broad-extraction prompt knows what kind of doc
  // it's looking at and can be told which page ranges hold which content.
  // gemini-2.5-flash + the full PDF; cost ~$0.05 / doc.
  // Only runs on PDFs (image / text-fallback paths skip).
  //
  // Failures here are SOFT — pass 1 falls back to the old all-fields-required
  // behaviour. We never block extraction on a classifier hiccup.
  // -------------------------------------------------------------------------
  let classifications: ClassificationEntry[] | null = null;
  if (isPdfType) {
    try {
      logStep(4, TOTAL_STEPS, 'ANALYSIS', 'Pass 0: classifying document');
      if (processingMode === 'gemini-file' && geminiFileUri) {
        classifications = await classifyDocumentFromFile(geminiFileUri, fileSize);
      } else if (processingMode === 'pdf-inline' && pdfBase64) {
        classifications = await classifyDocumentInline(pdfBase64);
      }
      if (classifications && classifications.length > 0) {
        log('INFO', 'ANALYSIS', `✅ Pass 0: ${classifications.length} segments — ${classifications.map(c => `${c.type}(${c.pageStart}-${c.pageEnd})`).join(', ')}`);
      }
    } catch (classifyErr) {
      log('WARN', 'ANALYSIS', `Pass 0 classifier failed (continuing without classifications): ${classifyErr instanceof Error ? classifyErr.message : String(classifyErr)}`);
      classifications = null;
    }
  }

  // Step 5: Generate AI analysis
  logStep(5, TOTAL_STEPS, 'ANALYSIS', 'Generating AI analysis');

  const { systemPrompt, userPrompt } = buildPrompts(
    claimDetails, fileName, documentType, fileSize, processingMode,
    classifications as DocumentClassification[] | null,
  );

  // Build a type-aware Gemini responseSchema once. Pass 1 + retry calls will
  // pass this to the model so JSON well-formedness is enforced structurally.
  const responseSchema = buildResponseSchema(classifications as DocumentClassification[] | null);

  // Legal/demand docs carry the highest-value, hardest-to-read fields (attorney
  // firm in the letterhead, time-limit on the last page, demand amount, claimant
  // identity). Flash misreads demand packets — route them to gemini-2.5-pro
  // regardless of size.
  const LEGAL_TYPES = ['demand_letter', 'correspondence'];
  const forcePro = Array.isArray(classifications) &&
    (classifications as DocumentClassification[]).some((c) => LEGAL_TYPES.includes(c.type));
  // 65536 output tokens (up from the 32768 default): dense multi-page chunks were
  // truncating mid-JSON, the main cause of "Unable to parse structured analysis"
  // (the structured output is valid until it gets cut off).
  const EXTRACTION_MAX_TOKENS = 65536;

  let aiContent: string = '';

  if (processingMode === 'gemini-file' && geminiFileUri && geminiFileName) {
    try {
      aiContent = await generateWithGeminiFile(geminiFileUri, systemPrompt, userPrompt, fileSize, {
        responseSchema,
        maxOutputTokens: EXTRACTION_MAX_TOKENS,
        ...(forcePro ? { model: 'gemini-2.5-pro' as const } : {}),
      });
    } finally {
      await deleteGeminiFile(geminiFileName);
    }
  } else {
    // Inline content via the Gemini API: PDF base64 / image base64 / text-only.
    // Single API key (GEMINI_API_KEY) — same auth as the Files-API path above.
    const parts: GeminiPart[] = [{ text: userPrompt }];

    if (processingMode === 'pdf-inline' && pdfBase64) {
      parts.push({ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } });
    } else if (processingMode === 'vision-url' && fileUrl) {
      // The Gemini API doesn't accept arbitrary image URLs — fetch and inline.
      const imgResponse = await fetch(fileUrl);
      if (!imgResponse.ok) throw new Error(`Failed to fetch image: ${imgResponse.status}`);
      const imgBuffer = await imgResponse.arrayBuffer();
      const imgBase64 = arrayBufferToBase64(imgBuffer);
      const imgMime = imgResponse.headers.get('content-type') || mimeType || 'image/jpeg';
      parts.push({ inlineData: { mimeType: imgMime, data: imgBase64 } });
    }
    // text-fallback uses just the userPrompt text part — no inline data.

    const modelToUse = (forcePro || fileSize > 5 * 1024 * 1024) ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
    // Image / text-fallback paths skip responseSchema — only PDF extraction uses
    // the structured-output enforcement (vision JSON shape differs) — but all
    // paths get the raised output-token budget to avoid mid-JSON truncation.
    const inlineOpts = processingMode === 'pdf-inline'
      ? { responseSchema, maxOutputTokens: EXTRACTION_MAX_TOKENS }
      : { maxOutputTokens: EXTRACTION_MAX_TOKENS };
    aiContent = await generateWithInlineContent(parts, systemPrompt, modelToUse, inlineOpts);
  }

  // Step 6: Parse response
  logStep(6, TOTAL_STEPS, 'ANALYSIS', 'Parsing and structuring response');
  
  let analysisResult;
  try {
    analysisResult = parseAIResponse(aiContent);
  } catch (parseError) {
    analysisResult = {
      summary: PARSE_FAIL_STUB,
      rawAnalysis: true,
      rawContent: aiContent,
      correspondenceVerification: { status: 'needs_review', notes: 'AI response could not be parsed' },
      confidenceScore: 0.5
    };
  }

  analysisResult.processingMode = processingMode;
  analysisResult.fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
  analysisResult.modelUsed = forcePro
    ? 'gemini-2.5-pro'
    : (processingMode === 'gemini-file'
        ? (fileSize > PRO_MODEL_THRESHOLD ? 'gemini-2.5-pro' : 'gemini-2.5-flash')
        : (fileSize > 5 * 1024 * 1024 ? 'gemini-2.5-pro' : 'gemini-2.5-flash'));

  // Stash classifications on the result so the orchestrator (multi-pass block)
  // can thread them through Pass 2 (gap-fill), Pass 4 (self-heal), Pass 5
  // (grounding). The orchestrator also persists them to the dedicated
  // claim_documents.document_classifications column.
  if (classifications) {
    analysisResult._documentClassifications = classifications;
  }

  logTiming('ANALYSIS', 'Total analysis time', totalStartTime);
  log('INFO', 'ANALYSIS', '🎉 ANALYSIS COMPLETE');

  return analysisResult;
}

// ============================================================================
// ANALYSIS WITH PROGRESS TRACKING
// ============================================================================

async function performAnalysisWithProgress(
  fileName: string, fileSize: number, mimeType: string,
  storagePath: string | undefined, fileUrl: string | undefined,
  fileBase64: string | undefined, documentContent: string | undefined,
  documentType: string, claimDetails: ClaimDetails, jobCtx: JobProgress | null
) {
  if (jobCtx) await updateJobProgress(jobCtx, 15, 'Preparing document for analysis...');

  const HAS_GEMINI = !!Deno.env.get('GEMINI_API_KEY');
  const isPdfType = mimeType === 'application/pdf' || fileName?.toLowerCase().endsWith('.pdf');
  const useGeminiFile = fileSize > GEMINI_FILE_API_THRESHOLD && HAS_GEMINI && isPdfType;

  if (jobCtx && useGeminiFile) {
    await addJobLog(jobCtx, 'info', `Large file detected (${(fileSize / 1024 / 1024).toFixed(1)} MB), using Gemini Files API`);
  }

  if (jobCtx) await updateJobProgress(jobCtx, 30, 'AI analyzing document content...');

  const result = await performAnalysis(
    fileName, fileSize, mimeType, storagePath, fileUrl, fileBase64, documentContent, documentType, claimDetails
  );

  if (jobCtx) await updateJobProgress(jobCtx, 85, 'Parsing and structuring analysis results...');

  return result;
}

// ============================================================================
// REQUEST HANDLER
// ============================================================================

serve(async (req) => {
  const requestId = crypto.randomUUID().substring(0, 8);
  log('INFO', `REQ-${requestId}`, '📨 INCOMING REQUEST');

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Scanner short-circuit. analyze-claim-document is internal-only (called
  // by pull-claim with service-role bearer; verify_jwt=false). Guard fires
  // immediately to prevent storage downloads + Gemini API calls during scans.
  const scannerEarly = scannerShortCircuit(req, corsHeaders);
  if (scannerEarly) return scannerEarly;

  try {
    const requestData: AnalyzeRequest = await req.json();
    
    // Async mode (triggered by database)
    if (requestData.async && requestData.documentId) {
      log('INFO', `REQ-${requestId}`, '🔄 ASYNC MODE');
      const documentId = requestData.documentId;

      // PHASE 2 staged path: when invoked with a `stage` (by the pgmq pump,
      // gated by the staged_analysis_enabled flag), run ONE stage and return.
      // The monolithic background path below is used when no `stage` is given.
      const stage = (requestData as { stage?: string }).stage;
      const msgId = (requestData as { msgId?: number }).msgId;
      if (stage) {
        const stagedPromise = runAnalysisStage(documentId, stage, msgId);
        try {
          const edgeRuntime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<void>) => void } }).EdgeRuntime;
          if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(stagedPromise);
        } catch (_e) { /* ignore */ }
        return new Response(JSON.stringify({ success: true, async: true, documentId, stage, message: `stage ${stage} started` }), {
          status: 202,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const backgroundProcessingPromise = (async () => {
        const bgStartTime = Date.now();
        const supabase = getSupabaseAdmin();
        const jobId = await createProcessingJob(supabase, documentId);
        const jobCtx: JobProgress | null = jobId ? { jobId, supabase } : null;
        
        try {
          if (jobCtx) await updateJobProgress(jobCtx, 5, 'Starting...', 'processing');
          
          await updateDocumentStatus(documentId, 'processing');
          const doc = await loadDocumentFromDatabase(documentId);

          // Defensive: claim_documents rows can have file_url=NULL when
          // fetch-sor-document failed to retrieve the PDF (proxy
          // 403/404, content_unavailable, etc). Without this check the
          // `.match()` below crashes with "Cannot read properties of null".
          // Mark the doc as failed with a clear message and bail — there's
          // nothing to analyze.
          const fileUrl = doc.file_url as string | null;
          if (!fileUrl) {
            log('WARN', 'ANALYSIS', `Document ${documentId} has no file_url — content unavailable, skipping`);
            await updateDocumentStatus(documentId, 'failed', {
              processing_error: 'content_unavailable: file_url is null (PDF was never fetched from source)',
            });
            if (jobCtx) await updateJobProgress(jobCtx, 100, 'Skipped: no PDF content', 'failed');
            return;
          }
          // Bucket is private; file_url stores a bare path (legacy rows may hold a
          // full public URL). The helper normalises both → storage path so the
          // service-role download below works regardless.
          const storagePath = storagePathFromFileUrl(fileUrl);
          
          const claimDetails: ClaimDetails = {
            claimNumber: doc.claims?.claim_number || 'Unknown',
            claimType: doc.claims?.claim_type || 'Unknown',
            incidentDate: doc.claims?.incident_date || 'Unknown',
            incidentDescription: doc.claims?.incident_description || '',
            claimantName: doc.claims?.claimant_name || 'Unknown',
            accidentLocation: doc.claims?.accident_location,
          };
          
          const claimDetailsObj = doc.claim_details as { was_split?: boolean; chunk_files?: string[]; } | null;
          const wasSplit = claimDetailsObj?.was_split || false;
          const chunkFiles = claimDetailsObj?.chunk_files || [];
          
          let analysisResult: any;
          // Tracks whether the grounding pass flags this doc for human review.
          // Written by the Pass 5 block below; consumed by the final
          // updateDocumentStatus(...) call so the status doesn't get
          // overwritten by an unconditional 'completed' write.
          let finalStatus: 'completed' | 'needs_review' = 'completed';

          if (wasSplit && chunkFiles.length > 1) {
            const chunkResults: unknown[] = [];
            for (let i = 0; i < chunkFiles.length; i++) {
              const chunkFile = chunkFiles[i];
              if (jobCtx) await updateJobProgress(jobCtx, 15 + Math.floor((i / chunkFiles.length) * 70), `Analyzing part ${i + 1} of ${chunkFiles.length}...`);
              
              const chunkResult = await performAnalysisWithProgress(
                `${doc.file_name} (Part ${i + 1}/${chunkFiles.length})`,
                doc.file_size ? Math.floor(doc.file_size / chunkFiles.length) : 0,
                doc.mime_type || 'application/pdf',
                chunkFile, undefined, undefined, undefined, doc.document_type, claimDetails, null
              );
              chunkResults.push(chunkResult);
            }
            
            if (jobCtx) await updateJobProgress(jobCtx, 90, 'Merging analysis results...');
            analysisResult = mergeChunkResults(chunkResults, doc.file_name);
          } else {
            analysisResult = await performAnalysisWithProgress(
              doc.file_name, doc.file_size || 0, doc.mime_type || 'application/pdf',
              storagePath, fileUrl, undefined, undefined, doc.document_type, claimDetails, jobCtx
            );
          }

          // A parse failure leaves a `rawAnalysis` stub with NO structured data.
          // Surface it for human review (and keep rawContent) instead of silently
          // marking the doc 'completed' with everything lost.
          if (analysisResult?.rawAnalysis === true) {
            finalStatus = 'needs_review';
            log('WARN', 'ANALYSIS', `Doc ${documentId}: extraction did not parse — marking needs_review (rawContent preserved for re-run)`);
          } else if (analysisResult?._partialJsonRecovery === true) {
            // The model output was truncated and we salvaged partial JSON. The
            // data we DID get is persisted, but flag it so a reviewer (and the
            // synthesis completeness pass) knows the extraction is incomplete.
            finalStatus = 'needs_review';
            log('WARN', 'ANALYSIS', `Doc ${documentId}: extraction JSON truncated + salvaged — marking needs_review (partial data persisted)`);
          }

          // ============================================================================
          // MULTI-PASS EXTRACTION PIPELINE (Pass 2 & Pass 3)
          // ============================================================================

          try {
            log('INFO', 'MULTI_PASS', '🔄 Starting multi-pass extraction pipeline');

            // Pass 1 results are in analysisResult (from AI above)
            log('INFO', 'MULTI_PASS', '✅ Pass 1 (Broad extraction): Complete');

            // Pass 0 classifications were stamped on analysisResult by performAnalysis;
            // pull them off and persist to the dedicated DB column, then thread
            // through Pass 2-5 so each pass is type-aware.
            const classifications: DocumentClassification[] | null =
              (analysisResult._documentClassifications as DocumentClassification[] | undefined) ?? null;
            if (classifications && classifications.length > 0) {
              try {
                const primary = pickPrimaryType(classifications);
                await getSupabaseAdmin()
                  .from('claim_documents')
                  .update({
                    document_classifications: classifications,
                    document_type: primary,
                  })
                  .eq('id', documentId);
                log('INFO', 'MULTI_PASS', `✅ Persisted classifications (primary=${primary})`);
              } catch (persistErr) {
                log('WARN', 'MULTI_PASS', `Could not persist classifications: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`);
              }
            }

            // Extract and persist document text structure for targeted extraction
            const totalPages = 0; // TODO: Extract from PDF metadata if available
            const extractedText = await extractAndPersistText(documentId, analysisResult, totalPages);
            log('INFO', 'MULTI_PASS', `✅ Text extraction: ${extractedText.pages.length} pages, ${Object.keys(extractedText.sections).length} sections identified`);

            // Pass 2: Gap-fill extraction for missing fields (classification-aware:
            // a status-email doc no longer retries medical fields it can't have)
            const missingFields = getFieldsForRetry(analysisResult, classifications);
            if (missingFields.length > 0) {
              log('INFO', 'MULTI_PASS', `🔍 Pass 2 (Gap-fill): Targeting ${missingFields.length} missing fields`);
              if (jobCtx) await updateJobProgress(jobCtx, 92, `Extracting ${missingFields.length} missing fields...`);

              analysisResult = await performGapFillExtraction(analysisResult, extractedText, documentId, undefined, classifications);
              log('INFO', 'MULTI_PASS', '✅ Pass 2 (Gap-fill): Complete');
            } else {
              log('INFO', 'MULTI_PASS', '✅ Pass 2 (Gap-fill): Skipped - all fields extracted in Pass 1');
            }

            // Pass 3: Validation, deduplication, and aggregation
            log('INFO', 'MULTI_PASS', '🔍 Pass 3 (Validation): Starting deduplication and aggregation');
            if (jobCtx) await updateJobProgress(jobCtx, 94, 'Validating and aggregating results...');

            const { merged, validation } = validateAndAggregateResults(analysisResult, {}, EXTRACTION_SCHEMA);
            analysisResult = merged;

            log('INFO', 'MULTI_PASS', `✅ Pass 3 (Validation): ${validation.fieldsPassed}/${validation.fieldsChecked} fields passed`);

            // Log validation issues
            for (const issue of validation.issues) {
              if (issue.severity === 'error') {
                log('ERROR', 'MULTI_PASS', `Validation error: ${issue.field} - ${issue.message}`);
              } else if (issue.severity === 'warning') {
                log('WARN', 'MULTI_PASS', `Validation warning: ${issue.field} - ${issue.message}`);
              } else {
                log('INFO', 'MULTI_PASS', `Validation info: ${issue.field} - ${issue.message}`);
              }
            }

            // Pass 4: Completeness Analysis & Self-Healing Retry
            log('INFO', 'MULTI_PASS', '🔍 Pass 4 (Completeness): Calculating extraction quality');
            const completenessReport = calculateCompleteness(analysisResult, EXTRACTION_SCHEMA);

            log('INFO', 'MULTI_PASS', `📊 Completeness: ${(completenessReport.overallScore * 100).toFixed(1)}% | Recommendation: ${completenessReport.recommendation.toUpperCase()}`);
            log('INFO', 'MULTI_PASS', `   Required: ${(completenessReport.requiredFieldsScore * 100).toFixed(1)}% | Optional: ${(completenessReport.optionalFieldsScore * 100).toFixed(1)}%`);
            log('INFO', 'MULTI_PASS', `   Complete: ${completenessReport.completeFields}/${completenessReport.totalFields} fields`);

            // Save completeness score to database
            await saveCompletenessScore(documentId, completenessReport.overallScore);

            // Log this extraction pass for debugging
            const fieldsExtractedThisPass = Object.keys(completenessReport.fieldScores).filter(
              fieldName => completenessReport.fieldScores[fieldName].quality !== 'missing'
            );
            await logExtractionPass(documentId, 3, fieldsExtractedThisPass, completenessReport.overallScore);

            // Self-healing: Retry if completeness below threshold
            const COMPLETENESS_THRESHOLD = 0.7; // 70% minimum for acceptance
            if (completenessReport.recommendation === 'retry' && completenessReport.overallScore < COMPLETENESS_THRESHOLD) {
              log('WARN', 'MULTI_PASS', `⚠️ Completeness ${(completenessReport.overallScore * 100).toFixed(1)}% below threshold ${(COMPLETENESS_THRESHOLD * 100).toFixed(0)}%`);
              log('INFO', 'MULTI_PASS', '🔄 Pass 4 (Self-Healing): Performing ultra-focused extraction for failed fields');

              if (jobCtx) await updateJobProgress(jobCtx, 96, 'Self-healing: Re-extracting low-quality fields...');

              // Get fields that need retry (missing or poor quality)
              const retryFields = getRetryFieldsFromReport(completenessReport);

              if (retryFields.length > 0) {
                log('INFO', 'MULTI_PASS', `🎯 Targeting ${retryFields.length} fields: ${retryFields.join(', ')}`);

                // Build ultra-focused analysis for failed fields
                const failedFieldDefs = retryFields
                  .map(fieldName => getFieldDefinition(fieldName))
                  .filter(def => def !== undefined);

                // Convert to Record<string, any> for gap-fill extraction
                const failedFieldsMap: Record<string, any> = {};
                for (const fieldName of retryFields) {
                  failedFieldsMap[fieldName] = null; // Mark as missing for gap-fill
                }

                // Run ultra-focused gap-fill on failed fields only
                const pass4Result = await performGapFillExtraction(failedFieldsMap, extractedText, documentId, undefined, classifications);

                // Merge Pass 4 results
                for (const [fieldName, value] of Object.entries(pass4Result)) {
                  if (value !== null && value !== undefined) {
                    // Use setNestedValue if we had it, but for now just direct assignment
                    const keys = fieldName.split('.');
                    let current = analysisResult;
                    for (let i = 0; i < keys.length - 1; i++) {
                      const key = keys[i];
                      if (!current[key]) current[key] = {};
                      current = current[key];
                    }
                    current[keys[keys.length - 1]] = value;

                    log('INFO', 'MULTI_PASS', `✅ Pass 4 recovered: ${fieldName}`);
                  }
                }

                // Recalculate completeness after Pass 4
                const finalCompleteness = calculateCompleteness(analysisResult, EXTRACTION_SCHEMA);
                log('INFO', 'MULTI_PASS', `📊 After Pass 4: ${(finalCompleteness.overallScore * 100).toFixed(1)}% (${finalCompleteness.recommendation.toUpperCase()})`);

                // Update database with final completeness
                await saveCompletenessScore(documentId, finalCompleteness.overallScore);

                // Log Pass 4 results
                const fieldsRecovered = retryFields.filter(fieldName =>
                  finalCompleteness.fieldScores[fieldName]?.quality !== 'missing'
                );
                await logExtractionPass(documentId, 4, fieldsRecovered, finalCompleteness.overallScore);

                const improvement = finalCompleteness.overallScore - completenessReport.overallScore;
                if (improvement > 0) {
                  log('INFO', 'MULTI_PASS', `✅ Self-healing improved completeness by ${(improvement * 100).toFixed(1)}%`);
                } else {
                  log('WARN', 'MULTI_PASS', '⚠️ Self-healing did not improve completeness');
                }
              } else {
                log('INFO', 'MULTI_PASS', 'No fields identified for retry');
              }
            } else {
              log('INFO', 'MULTI_PASS', `✅ Pass 4 (Self-Healing): Skipped - completeness ${(completenessReport.overallScore * 100).toFixed(1)}% meets threshold`);
            }

            // Stamp the latest completeness score onto ai_analysis JSON. The DB
            // column already has it; the JSON copy is what the frontend reads.
            const latestCompleteness = calculateCompleteness(analysisResult, EXTRACTION_SCHEMA);
            analysisResult.extraction_completeness = latestCompleteness.overallScore;

            // ====================================================================
            // PASS 5: Anthropic Grounding & Repair Loop
            //
            // Claude (via the Anthropic API) reads the source PDF + the Gemini output,
            // grades each section, and emits targeted repair instructions. Repairs
            // feed back into performGapFillExtraction with correctiveGuidance.
            // Gated behind ENABLE_ANTHROPIC_GROUNDING — when off, the pipeline is
            // byte-identical to the pre-grounding behavior.
            // ====================================================================
            const groundingEnabled = Deno.env.get('ENABLE_ANTHROPIC_GROUNDING') === 'true';
            // Time-box grounding against the 400 s Edge worker wall-clock. Pass 5
            // runs LAST — extraction is already complete (~97%) and lives in
            // analysisResult. On dense scanned chunks grounding overran, and the
            // worker was hard-killed mid-grounding BEFORE the 'completed' write
            // below — stranding the doc in 'processing' as a zombie AND losing
            // the finished extraction. Cap total elapsed work at ~330 s so there
            // is always margin to persist the (completed) extraction afterward.
            // If grounding can't finish in the remaining budget we keep the
            // Pass 1-4 result, which is exactly what the catch below already does.
            const groundingBudgetMs = 330_000 - (Date.now() - bgStartTime);
            // Skip grounding for very large PDFs — it loads the whole file
            // (+~33% as base64) for Anthropic and OOMs the 256 MB worker on
            // ~18 MB+ scans (a real cause of the oversized-chunk failures). Keep
            // the already-complete Pass 1-4 extraction.
            const groundingTooBig = (doc.file_size ?? 0) > 18 * 1024 * 1024;
            if (groundingEnabled && groundingBudgetMs >= 5_000 && !groundingTooBig) {
              log('INFO', 'MULTI_PASS', `🔍 Pass 5 (Grounding): enabled (≈${Math.round(groundingBudgetMs / 1000)}s budget left)`);
              if (jobCtx) await updateJobProgress(jobCtx, 97, 'Grounding extraction against source PDF...');

              try {
                // Race grounding against the remaining-budget timer. On timeout
                // we abandon grounding and proceed to persist the extraction.
                const groundingPromise = runGroundingPipeline(
                  analysisResult,
                  extractedText,
                  {
                    documentId,
                    classifications,
                    getPdfBuffer: storagePath
                      ? () => downloadFromStorage(storagePath)
                      : undefined,
                  },
                );
                // Swallow a late rejection if the timer wins the race — the
                // orphaned grounding promise must not surface as unhandled.
                groundingPromise.catch(() => { /* superseded by time-box */ });
                const groundingResult = await Promise.race([
                  groundingPromise,
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () => reject(new Error(`grounding_timeout: exceeded ≈${Math.round(groundingBudgetMs / 1000)}s budget — keeping Pass 1-4 result`)),
                      groundingBudgetMs,
                    )
                  ),
                ]);
                analysisResult = groundingResult.analysisResult;
                log('INFO', 'MULTI_PASS', `✅ Pass 5 (Grounding): status=${groundingResult.status} score=${groundingResult.score !== null ? (groundingResult.score * 100).toFixed(1) + '%' : 'n/a'} iterations=${groundingResult.iterations}`);

                // If Claude couldn't certify after the iteration cap, flag the
                // document for human review. Data is still saved — extraction
                // succeeded, certification just didn't pass. NOTE: we only
                // mark a local `finalStatus` variable here, NOT write to the DB
                // directly — the final updateDocumentStatus call below would
                // otherwise overwrite it with 'completed'.
                if (groundingResult.status === 'failed' || groundingResult.status === 'partial') {
                  finalStatus = 'needs_review';
                  log('WARN', 'MULTI_PASS', `⚠️ Document flagged needs_review (grounding ${groundingResult.status})`);
                }
              } catch (groundingError) {
                // Don't fail the whole pipeline on grounding errors OR the
                // time-box — degrade gracefully to Pass 1-4 results (already in
                // analysisResult), so the doc still completes with extraction.
                log('ERROR', 'MULTI_PASS', `Grounding skipped/failed (degrading to Pass 1-4): ${groundingError instanceof Error ? groundingError.message : String(groundingError)}`);
              }
            } else if (groundingEnabled && groundingTooBig) {
              log('WARN', 'MULTI_PASS', `⏭️ Pass 5 (Grounding): skipped — PDF ${((doc.file_size ?? 0) / 1048576).toFixed(0)}MB exceeds the 18MB grounding cap (OOM risk); persisting Pass 1-4 result`);
            } else if (groundingEnabled) {
              log('WARN', 'MULTI_PASS', `⏭️ Pass 5 (Grounding): skipped — only ≈${Math.round(groundingBudgetMs / 1000)}s left in the worker budget; persisting Pass 1-4 result`);
            } else {
              log('INFO', 'MULTI_PASS', '✅ Pass 5 (Grounding): Skipped - ENABLE_ANTHROPIC_GROUNDING is not "true"');
            }

            log('INFO', 'MULTI_PASS', '🎉 Multi-pass extraction pipeline complete');

          } catch (multiPassError) {
            // Multi-pass extraction failed, but don't fail the entire analysis
            // Properly stringify the error for logging
            let errorMessage: string;
            if (multiPassError instanceof Error) {
              errorMessage = multiPassError.message;
              if (multiPassError.stack) {
                log('DEBUG', 'MULTI_PASS', `Stack trace: ${multiPassError.stack}`);
              }
            } else if (typeof multiPassError === 'object') {
              try {
                errorMessage = JSON.stringify(multiPassError);
              } catch {
                errorMessage = String(multiPassError);
              }
            } else {
              errorMessage = String(multiPassError);
            }
            
            log('ERROR', 'MULTI_PASS', `Multi-pass extraction failed: ${errorMessage}`);
            log('WARN', 'MULTI_PASS', 'Continuing with Pass 1 results only');
            
            // Apply data mapping as fallback when multi-pass fails
            log('INFO', 'MULTI_PASS', 'Applying fallback data mapping for Pass 1 results');
            analysisResult = mapPostAccidentToProviderDetails(analysisResult);
          }

          // ============================================================================
          // ALWAYS apply data mapping after multi-pass (successful or fallback)
          // This ensures postAccidentRecap data is available in treatmentRecap.providerDetails
          // ============================================================================
          analysisResult = mapPostAccidentToProviderDetails(analysisResult);

          if (jobCtx) await updateJobProgress(jobCtx, 95, 'Saving analysis results...');
          
          // Save raw AI response BEFORE any post-processing for debugging
          const rawAnalysisResult = JSON.parse(JSON.stringify(analysisResult));
          log('DEBUG', 'POST_PROCESS', 'Saved raw AI response before post-processing');
          
          // Apply post-processing filters
          analysisResult = validateAndCleanFlags(analysisResult);
          analysisResult = normalizeRecapArrays(analysisResult);

          // Validate treatmentRecap arrays are populated
          if (analysisResult.treatmentRecap) {
            const hasNarrative = analysisResult.treatmentRecap.narrative && analysisResult.treatmentRecap.narrative.length > 50;
            const hasProviderDetails = analysisResult.treatmentRecap.providerDetails && analysisResult.treatmentRecap.providerDetails.length > 0;
            const hasImagingResults = analysisResult.treatmentRecap.imagingResults && analysisResult.treatmentRecap.imagingResults.length > 0;

            if (hasNarrative && !hasProviderDetails) {
              log('WARN', 'POST_PROCESS', '⚠️ Treatment narrative exists but providerDetails array is EMPTY - AI did not properly structure provider data');
            }

            if (hasNarrative && !hasImagingResults) {
              log('WARN', 'POST_PROCESS', '⚠️ Treatment narrative exists but imagingResults array is EMPTY - AI did not properly structure imaging data');
            }

            if (hasProviderDetails) {
              log('INFO', 'POST_PROCESS', `✅ Extracted ${analysisResult.treatmentRecap.providerDetails.length} provider details`);
            }

            if (hasImagingResults) {
              log('INFO', 'POST_PROCESS', `✅ Extracted ${analysisResult.treatmentRecap.imagingResults.length} imaging results`);
            }
          }

          // Save diagnosed injuries to reference table before stripping from main analysis
          if (analysisResult.diagnosedInjuries && Array.isArray(analysisResult.diagnosedInjuries) && analysisResult.diagnosedInjuries.length > 0) {
            try {
              const { error: injuriesError } = await supabase
                .from('document_analysis_results')
                .insert({
                  document_id: documentId,
                  analysis_type: 'diagnosed_injuries',
                  extracted_data: analysisResult.diagnosedInjuries,
                  confidence_score: analysisResult.diagnosedInjuriesConfidence ?? null,
                });

              if (injuriesError) {
                log('ERROR', 'POST_PROCESS', `Failed to save diagnosed injuries to reference table: ${injuriesError.message}`);
              } else {
                log('INFO', 'POST_PROCESS', `✅ Saved ${analysisResult.diagnosedInjuries.length} diagnosed injuries to reference table`);
              }
            } catch (err) {
              log('ERROR', 'POST_PROCESS', `Error saving diagnosed injuries: ${err}`);
            }
          }

          // Keep diagnosed injuries in main analysis for UI display

          // IMPORTANT: Sync claim details FIRST before document status update
          // Use rawAnalysisResult which has the unmodified extractedIdentifiers
          const claimId = doc.claim_id;
          if (claimId) {
            log('INFO', 'SYNC_CLAIM', `🔄 Starting claim sync for claim ${claimId}...`);
            try {
              await syncClaimDetailsFromAnalysis(documentId, claimId, rawAnalysisResult);
              log('INFO', 'SYNC_CLAIM', `✅ Claim sync completed for claim ${claimId}`);
            } catch (syncError) {
              log('ERROR', 'SYNC_CLAIM', `❌ Claim sync failed: ${syncError instanceof Error ? syncError.message : syncError}`);
            }
          } else {
            log('WARN', 'SYNC_CLAIM', 'No claim_id found on document, skipping claim sync');
          }

          // Save both raw and processed versions. finalStatus is normally
          // 'completed' but is set to 'needs_review' upstream when Pass 5
          // (Anthropic grounding) flags the doc as failed/partial.
          await updateDocumentStatus(documentId, finalStatus, {
            ai_analysis: analysisResult,
            ai_analysis_raw: rawAnalysisResult,
            ai_summary: summaryForDoc(analysisResult),
            correspondence_status: analysisResult.verification?.status || 'pending',
          });

          if (jobCtx) await updateJobProgress(jobCtx, 100, 'Analysis complete', 'completed');

          // Fire claim-level synthesis if this was the last sibling to finish.
          //
          // Race fix (2026-06-10): the OLD logic was "if no siblings in flight,
          // fire synthesis." Two docs on the same claim finishing within ms
          // of each other could both see the OTHER as still in-flight (their
          // SELECTs raced the other's UPDATE), so BOTH deferred. Neither
          // fired synthesis. On the 2026-06-10 100-claim drain, this stranded
          // 10/100 claims at synthesis_status='not_run'.
          //
          // New design: lock-first, then check.
          //  1. Atomically flip claims.synthesis_status from not_run/pending
          //     to running. Only one invocation per claim wins this.
          //  2. With the lock held, snapshot sibling state. The lock guarantees
          //     no OTHER analyze invocation will fire synthesis while we hold
          //     it, so the sibling counts we read are durable.
          //  3a. If no siblings in flight → fire synthesis.
          //  3b. If siblings still in flight → release the lock (revert to
          //      not_run). The last sibling to finish will acquire it cleanly.
          //
          // We always attempt the lock when a doc reaches terminal state.
          // Without the early sibling pre-check, no race window can hide.
          if (claimId) {
            try {
              const { data: locked, error: lockErr } = await supabase
                .from('claims')
                .update({ synthesis_status: 'running' })
                .eq('id', claimId)
                .in('synthesis_status', ['not_run', 'pending'])
                .select('id');

              if (lockErr) {
                log('WARN', 'SYNTHESIS', `Synthesis lock UPDATE failed: ${lockErr.message}`);
              } else if (!locked || locked.length === 0) {
                // Lost the race, OR synthesis already done/in-progress/failed.
                // Either way, this invocation has no work to do here.
                log('INFO', 'SYNTHESIS', `Synthesis lock already held / completed for ${claimId} — skipping`);
              } else {
                // We hold the lock. Now snapshot siblings under that lock.
                const { data: siblings } = await supabase
                  .from('claim_documents')
                  .select('id, processing_status')
                  .eq('claim_id', claimId);
                const inFlight = (siblings ?? []).filter(s =>
                  s.processing_status === 'pending' || s.processing_status === 'processing'
                );

                if (inFlight.length === 0) {
                  // We're the last terminal sibling. Fire synthesis.
                  const supabaseUrl = Deno.env.get('SUPABASE_URL');
                  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
                  if (supabaseUrl && serviceKey) {
                    fetch(`${supabaseUrl}/functions/v1/synthesize-claim-extraction`, {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify({ claimId }),
                    }).catch(() => { /* fire-and-forget */ });
                    log('INFO', 'SYNTHESIS', `🎯 Triggered claim-level synthesis for ${claimId} (won lock, ${siblings?.length ?? 0} siblings all terminal)`);
                  }
                } else {
                  // Acquired the lock too early — siblings still in flight.
                  // Release the lock so the truly-last sibling can acquire it.
                  const { error: releaseErr } = await supabase
                    .from('claims')
                    .update({ synthesis_status: 'not_run' })
                    .eq('id', claimId);
                  if (releaseErr) {
                    log('WARN', 'SYNTHESIS', `Failed to release synthesis lock for ${claimId}: ${releaseErr.message}`);
                  } else {
                    log('INFO', 'SYNTHESIS', `⏳ ${inFlight.length} sibling doc(s) still in flight — released lock, deferring to last sibling`);
                  }
                }
              }
            } catch (synthErr) {
              log('WARN', 'SYNTHESIS', `Synthesis trigger check failed: ${synthErr instanceof Error ? synthErr.message : synthErr}`);
            }
          }

          // Keep a large manual claim draining without waiting for the watchdog:
          // now that this doc is terminal, dispatch the next pending sibling.
          if (claimId) await chainNextManualSibling(supabase, claimId, documentId);

          logTiming(`BG-${documentId}`, 'Total background processing', bgStartTime);
          log('INFO', `BG-${documentId}`, '🎉 BACKGROUND PROCESSING COMPLETE');
          
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const errorCode = error instanceof Error ? getErrorCode(error) : 'UNKNOWN';

          // Rate-limit / 503 / timeout are recoverable — keep the doc in
          // `pending` so the watchdog (sor_redispatch_stuck_pending)
          // re-fires analyze later. Marking these `failed` would silently
          // bury them (the daily-diff sweep only retries pending_content).
          const retryableCodes: string[] = [
            ERROR_CODES.GEMINI_RATE_LIMIT,
            ERROR_CODES.GEMINI_503,
            ERROR_CODES.TIMEOUT,
          ];
          const docStatus = retryableCodes.includes(errorCode) ? 'pending' : 'failed';

          log('ERROR', `BG-${documentId}`, '❌ Background processing failed', { error: errorMessage, errorCode, docStatus });

          if (jobCtx) await updateJobProgress(jobCtx, 0, 'Processing failed', 'failed', errorMessage, errorCode);
          await updateDocumentStatus(documentId, docStatus, { processing_error: errorMessage });

          // A terminal 'failed' frees this doc's concurrency slot — chain the
          // next pending sibling so the claim keeps draining. For a retryable
          // 'pending' status the doc keeps its slot and will be retried, so we
          // do NOT chain (that would push in-flight above the cap).
          if (docStatus === 'failed') {
            try {
              const { data: d } = await supabase
                .from('claim_documents')
                .select('claim_id')
                .eq('id', documentId)
                .maybeSingle();
              const cid = (d as { claim_id?: string } | null)?.claim_id;
              if (cid) await chainNextManualSibling(supabase, cid, documentId);
            } catch { /* non-fatal — watchdog backstop covers this */ }
          }
        }
      })();

      try {
        const edgeRuntime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (promise: Promise<void>) => void } }).EdgeRuntime;
        if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(backgroundProcessingPromise);
      } catch (e) {
        log('DEBUG', `REQ-${requestId}`, `EdgeRuntime.waitUntil error: ${e}`);
      }

      return new Response(JSON.stringify({ success: true, async: true, documentId, message: 'Analysis started in background' }), {
        status: 202,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    // Sync mode
    log('INFO', `REQ-${requestId}`, '⚡ SYNC MODE');
    const { documentContent, documentType, fileName, mimeType, fileBase64, fileUrl, storagePath, claimDetails } = requestData;
    
    if (!claimDetails) throw new Error('claimDetails is required');
    
    let fileSize = 0;
    if (storagePath) {
      const buffer = await downloadFromStorage(storagePath);
      fileSize = buffer.byteLength;
    } else if (fileBase64) {
      fileSize = Math.floor(fileBase64.length * 0.75);
    } else if (fileUrl) {
      try {
        const headResponse = await fetch(fileUrl, { method: 'HEAD' });
        const contentLength = headResponse.headers.get('content-length');
        fileSize = contentLength ? parseInt(contentLength, 10) : 0;
      } catch { fileSize = 0; }
    }
    
    const analysisResult = await performAnalysis(
      fileName || 'document', fileSize, mimeType || 'application/pdf',
      storagePath, fileUrl, fileBase64, documentContent, documentType || 'other', claimDetails
    );

    return new Response(JSON.stringify({ success: true, analysis: analysisResult }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    log('ERROR', `REQ-${requestId}`, '❌ Request failed', { error: error instanceof Error ? error.message : String(error) });
    
    return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error occurred' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
