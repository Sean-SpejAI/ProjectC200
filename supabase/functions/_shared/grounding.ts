// Pass 5: Anthropic-driven grounding & repair loop.
//
// After Gemini's Pass 1-4 finish, Claude (via Azure AI Foundry) reads the
// source PDF and the extracted JSON, grades each schema section, and emits
// targeted repair instructions for any section it flags weak or fail.
// Repair instructions flow back through performGapFillExtraction with the
// new correctiveGuidance parameter; we then re-call Claude to verify the fix.
//
// Up to 2 repair iterations (3 total grounding calls). Failure modes degrade
// gracefully: if Anthropic is unreachable or returns malformed output, we
// leave the Pass 1-4 results untouched and mark grounding_status='not_run'.

import { log } from './utils.ts';
import {
  callAnthropicForGrounding,
  GroundingVerdict,
  GroundingSourceBlock,
  SectionVerdict,
} from './azure-anthropic.ts';
import {
  buildGroundingRubric,
  DocumentClassification,
  EXTRACTION_SCHEMA,
  getFieldDefinition,
} from './extraction-schema.ts';
import { ExtractedTextStructure } from './text-extraction.ts';
import { performGapFillExtraction } from './gap-fill.ts';
import { logExtractionPass, saveGroundingResult } from './completeness.ts';

// Anthropic's documented PDF limit. Base64 inflates roughly 33%, so we cap
// the *raw* PDF size at 32MB which leaves headroom for the encoded payload.
const ANTHROPIC_PDF_MAX_BYTES = 32 * 1024 * 1024;

const MAX_ITERATIONS = 2;       // 2 repairs => 3 total grounding calls
const ANTHROPIC_RETRY_LIMIT = 2; // consecutive Anthropic failures before bailing

export type GroundingStatus = 'passed' | 'partial' | 'failed' | 'skipped_oversize' | 'not_run';

export interface GroundingPipelineResult {
  analysisResult: any;
  status: GroundingStatus;
  score: number | null;
  iterations: number;
  finalVerdict: GroundingVerdict | null;
}

export interface RunGroundingOpts {
  documentId: string;
  /**
   * Lazy fetcher for the PDF bytes. Only invoked if grounding decides to send
   * the PDF directly — keeps callers that stream uploads to Gemini from
   * pre-downloading on grounding's behalf.
   */
  getPdfBuffer?: () => Promise<ArrayBuffer | null>;
  maxIterations?: number;
  /**
   * Pass 0 classifier output. When provided, the grounding rubric uses
   * type-aware "required" semantics so a status-email doc isn't dinged for
   * missing medical fields. Falls back to all-required behaviour if omitted.
   */
  classifications?: DocumentClassification[] | null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function verdictWeight(v: SectionVerdict['verdict']): number {
  if (v === 'pass') return 1.0;
  if (v === 'weak') return 0.5;
  return 0;
}

/**
 * Roll per-section verdicts up to a single score. Required-field sections
 * weighted 2x to match the completeness-score weighting convention, so the
 * two numbers are directly comparable in the UI.
 */
function computeGroundingScore(verdict: GroundingVerdict): number {
  let total = 0;
  let weight = 0;
  for (const [name, section] of Object.entries(verdict.sections)) {
    const def = getFieldDefinition(name);
    const w = def?.required ? 2 : 1;
    total += verdictWeight(section.verdict) * w;
    weight += w;
  }
  return weight > 0 ? total / weight : 0;
}

function deriveStatus(verdict: GroundingVerdict): GroundingStatus {
  const sections = Object.values(verdict.sections);
  const hasFail = sections.some(s => s.verdict === 'fail');
  const hasWeak = sections.some(s => s.verdict === 'weak');
  if (!hasFail && !hasWeak) return 'passed';
  if (hasFail) return 'failed';
  return 'partial';
}

function collectRepairs(verdict: GroundingVerdict): Record<string, string> {
  const repairs: Record<string, string> = {};
  for (const [name, section] of Object.entries(verdict.sections)) {
    if ((section.verdict === 'fail' || section.verdict === 'weak') && section.repair_instruction) {
      repairs[name] = section.repair_instruction;
    }
  }
  return repairs;
}

/**
 * Fixed-point detector: if two consecutive iterations produce the same set of
 * non-pass sections, further repairs are unlikely to help and we stop early.
 */
function verdictsEquivalent(a: GroundingVerdict, b: GroundingVerdict): boolean {
  const aKeys = Object.keys(a.sections).sort();
  const bKeys = Object.keys(b.sections).sort();
  if (aKeys.join('|') !== bKeys.join('|')) return false;
  for (const k of aKeys) {
    if (a.sections[k].verdict !== b.sections[k].verdict) return false;
  }
  return true;
}

function getFieldNames(): string[] {
  return Object.keys(EXTRACTION_SCHEMA);
}

function concatPdfText(extractedText: ExtractedTextStructure): string {
  // Send pages in order; cap so the call doesn't blow the context window.
  // ~250K chars ≈ 60K tokens which leaves room for the rubric + Gemini output.
  const joined = extractedText.pages.map(p => `--- Page ${p.page} ---\n${p.text}`).join('\n\n');
  return joined.length > 250000 ? joined.substring(0, 250000) + '\n...[truncated]' : joined;
}

/**
 * Decide whether to send the PDF directly or fall back to extracted text.
 * Returns null if the document is fundamentally unanalyzable here (no PDF
 * available AND no extracted text) — the orchestrator records skipped_oversize
 * and bails.
 */
async function resolveSource(
  extractedText: ExtractedTextStructure,
  getPdfBuffer: (() => Promise<ArrayBuffer | null>) | undefined,
): Promise<{ source: GroundingSourceBlock; mode: 'pdf' | 'text-fallback' } | null> {
  if (getPdfBuffer) {
    try {
      const buf = await getPdfBuffer();
      if (buf && buf.byteLength > 0 && buf.byteLength <= ANTHROPIC_PDF_MAX_BYTES) {
        log('INFO', 'GROUNDING', `Using PDF source (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)`);
        return {
          source: { kind: 'pdf', mediaType: 'application/pdf', base64: arrayBufferToBase64(buf) },
          mode: 'pdf',
        };
      }
      if (buf) {
        log('WARN', 'GROUNDING', `PDF too large for Anthropic (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB > ${ANTHROPIC_PDF_MAX_BYTES / 1024 / 1024} MB) — falling back to text`);
      }
    } catch (err) {
      log('WARN', 'GROUNDING', `Could not fetch PDF for grounding: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const text = concatPdfText(extractedText);
  if (!text.trim()) {
    log('WARN', 'GROUNDING', 'No PDF and no extracted text — cannot ground');
    return null;
  }
  log('INFO', 'GROUNDING', `Using text-fallback source (${text.length} chars)`);
  return { source: { kind: 'text', text }, mode: 'text-fallback' };
}

/**
 * Execute the grounding + repair loop. Caller is expected to have already
 * persisted Pass 1-4 results to claim_documents.ai_analysis; this function
 * may further mutate analysisResult via gap-fill repairs and then writes
 * the grounding outcome onto the document.
 */
export async function runGroundingPipeline(
  analysisResult: any,
  extractedText: ExtractedTextStructure,
  opts: RunGroundingOpts,
): Promise<GroundingPipelineResult> {
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
  const fieldNames = getFieldNames();
  const rubric = buildGroundingRubric(opts.classifications);

  const resolved = await resolveSource(extractedText, opts.getPdfBuffer);
  if (!resolved) {
    await saveGroundingResult(opts.documentId, {
      status: 'skipped_oversize',
      score: null,
      iterations: 0,
      evaluation: null,
    });
    return { analysisResult, status: 'skipped_oversize', score: null, iterations: 0, finalVerdict: null };
  }

  let working = analysisResult;
  let priorVerdict: GroundingVerdict | undefined;
  let lastVerdict: GroundingVerdict | null = null;
  let iteration = 0;
  let consecutiveFailures = 0;

  // 0 = initial grounding, then up to maxIterations repair cycles.
  for (let i = 0; i <= maxIterations; i++) {
    iteration = i;
    log('INFO', 'GROUNDING', `🔍 Grounding iteration ${i} (${resolved.mode})`);

    let verdict: GroundingVerdict;
    try {
      const { verdict: v } = await callAnthropicForGrounding(
        resolved.source,
        working,
        fieldNames,
        rubric,
        i,
        priorVerdict,
      );
      verdict = v;
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      log('ERROR', 'GROUNDING', `Iteration ${i} failed (${consecutiveFailures}/${ANTHROPIC_RETRY_LIMIT}): ${err instanceof Error ? err.message : String(err)}`);
      if (consecutiveFailures >= ANTHROPIC_RETRY_LIMIT) {
        log('WARN', 'GROUNDING', 'Anthropic failed too many times — bailing with not_run status');
        await saveGroundingResult(opts.documentId, {
          status: 'not_run',
          score: lastVerdict ? computeGroundingScore(lastVerdict) : null,
          iterations: iteration,
          evaluation: lastVerdict,
        });
        return {
          analysisResult: working,
          status: 'not_run',
          score: lastVerdict ? computeGroundingScore(lastVerdict) : null,
          iterations: iteration,
          finalVerdict: lastVerdict,
        };
      }
      continue;
    }

    lastVerdict = verdict;

    const score = computeGroundingScore(verdict);
    const status = deriveStatus(verdict);
    log('INFO', 'GROUNDING', `   verdict=${verdict.overall_verdict} score=${(score * 100).toFixed(1)}% status=${status}`);

    // Audit this iteration. Pass numbers 5/6/7 distinguish grounding from
    // the earlier Gemini passes.
    const fieldsTouched = Object.keys(verdict.sections);
    await logExtractionPass(opts.documentId, 5 + i, fieldsTouched, score, {
      evaluatorVerdict: verdict,
      triggeredBy: i === 0 ? 'grounding_eval' : 'grounding_eval_repair',
    });

    // Stop conditions
    if (status === 'passed') {
      log('INFO', 'GROUNDING', '✅ All sections pass — exiting loop');
      await saveGroundingResult(opts.documentId, { status, score, iterations: iteration, evaluation: verdict });
      attachGroundingMetadata(working, verdict, iteration, status, score);
      return { analysisResult: working, status, score, iterations: iteration, finalVerdict: verdict };
    }

    if (i === maxIterations) {
      log('INFO', 'GROUNDING', `🛑 Iteration cap (${maxIterations}) reached with status=${status}`);
      await saveGroundingResult(opts.documentId, { status, score, iterations: iteration, evaluation: verdict });
      attachGroundingMetadata(working, verdict, iteration, status, score);
      return { analysisResult: working, status, score, iterations: iteration, finalVerdict: verdict };
    }

    if (priorVerdict && verdictsEquivalent(priorVerdict, verdict)) {
      log('INFO', 'GROUNDING', '🛑 Fixed point detected — exiting loop');
      await saveGroundingResult(opts.documentId, { status, score, iterations: iteration, evaluation: verdict });
      attachGroundingMetadata(working, verdict, iteration, status, score);
      return { analysisResult: working, status, score, iterations: iteration, finalVerdict: verdict };
    }

    // Build repair instructions and feed them into gap-fill.
    const repairs = collectRepairs(verdict);
    if (Object.keys(repairs).length === 0) {
      log('WARN', 'GROUNDING', 'Status not passed but no repair_instructions returned — exiting');
      await saveGroundingResult(opts.documentId, { status, score, iterations: iteration, evaluation: verdict });
      attachGroundingMetadata(working, verdict, iteration, status, score);
      return { analysisResult: working, status, score, iterations: iteration, finalVerdict: verdict };
    }

    log('INFO', 'GROUNDING', `🔧 Repairing ${Object.keys(repairs).length} fields: ${Object.keys(repairs).join(', ')}`);
    try {
      working = await performGapFillExtraction(working, extractedText, opts.documentId, repairs, opts.classifications);
    } catch (err) {
      log('ERROR', 'GROUNDING', `Repair gap-fill failed: ${err instanceof Error ? err.message : String(err)}`);
      // Skip repair, attempt another verification with the unmodified data
      // (loop will exit at iteration cap or fixed-point check).
    }

    priorVerdict = verdict;
  }

  // Defensive: loop above always returns inside the body.
  return { analysisResult: working, status: 'not_run', score: null, iterations: iteration, finalVerdict: lastVerdict };
}

/**
 * Attach a `_grounding` sibling to ai_analysis with per-section verdicts so
 * the frontend can render section-level badges in a future phase. Mirrors
 * the schema in plan §D. `status` is the rolled-up GroundingStatus the UI
 * uses to render the "Verified" / "Needs Review" badge in Phase 1.
 */
function attachGroundingMetadata(
  analysis: any,
  verdict: GroundingVerdict,
  iterations: number,
  status: GroundingStatus,
  score: number,
): void {
  const meta: Record<string, unknown> = {
    status,
    score,
    overall_verdict: verdict.overall_verdict,
    iterations,
    sections: {},
  };
  for (const [name, section] of Object.entries(verdict.sections)) {
    (meta.sections as Record<string, unknown>)[name] = {
      verdict: section.verdict,
      confidence: section.confidence,
      reasoning: section.reasoning,
      evidence_pages: section.evidence_pages ?? null,
    };
  }
  analysis._grounding = meta;
}
