// Anthropic client for the Azure AI Foundry Anthropic Messages proxy.
//
// The client is on Azure but routes Claude through the Anthropic Messages
// API surface. Auth scheme is Bearer (NOT the Azure subscription-key
// `api-key:` header) — verified 2026-05-16 against the eastus2 deployment.
// Endpoint and key live in Supabase secrets AZURE_ANTHROPIC_BASE and
// AZURE_ANTHROPIC_API_KEY (see project memory reference_azure_anthropic.md).
//
// This module is non-streaming on purpose: grounding evaluation depends on
// forced tool use to return structured JSON, which needs the full response.

import { log } from './utils.ts';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';

export type ContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | {
      type: 'document';
      source: { type: 'base64'; media_type: 'application/pdf'; data: string };
      cache_control?: { type: 'ephemeral' };
    }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicOpts {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  system?: string | ContentBlock[];
  tools?: AnthropicTool[];
  toolChoice?: { type: 'tool'; name: string } | { type: 'auto' } | { type: 'any' };
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicResponse {
  id: string;
  model: string;
  role: 'assistant';
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  usage: AnthropicUsage;
}

function getConfig(): { base: string; key: string } {
  const base = Deno.env.get('AZURE_ANTHROPIC_BASE');
  const key = Deno.env.get('AZURE_ANTHROPIC_API_KEY');
  if (!base) throw new Error('AZURE_ANTHROPIC_BASE is not configured');
  if (!key) throw new Error('AZURE_ANTHROPIC_API_KEY is not configured');
  return { base: base.replace(/\/+$/, ''), key };
}

const MAX_RETRIES = 5;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Backoff with jitter for retryable Anthropic errors.
 * - Honors `retry-after` if the server sends it (seconds or HTTP-date)
 * - Otherwise: 2^attempt seconds + 0-1s jitter, capped at 60s
 */
function backoffDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const asNum = Number(retryAfter);
    if (Number.isFinite(asNum) && asNum > 0) return Math.min(asNum * 1000, 60_000);
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) return Math.max(0, Math.min(asDate - Date.now(), 60_000));
  }
  const base = Math.min(2 ** attempt, 60) * 1000;
  return base + Math.floor(Math.random() * 1000);
}

export async function callAnthropic(
  messages: AnthropicMessage[],
  opts: AnthropicOpts = {},
): Promise<AnthropicResponse> {
  const { base, key } = getConfig();

  const body: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    messages,
  };

  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.system !== undefined) body.system = opts.system;
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;

  const bodyJson = JSON.stringify(body);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startTime = Date.now();
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: bodyJson,
    });

    const latencyMs = Date.now() - startTime;

    if (response.ok) {
      const result = await response.json() as AnthropicResponse;
      log(
        'INFO',
        'ANTHROPIC',
        `✅ ${result.model} | ${latencyMs}ms | in=${result.usage.input_tokens} out=${result.usage.output_tokens}` +
          (result.usage.cache_read_input_tokens ? ` cache_read=${result.usage.cache_read_input_tokens}` : '') +
          (result.usage.cache_creation_input_tokens ? ` cache_write=${result.usage.cache_creation_input_tokens}` : '') +
          (attempt > 0 ? ` (after ${attempt} retr${attempt === 1 ? 'y' : 'ies'})` : ''),
      );
      return result;
    }

    const errorText = await response.text();
    const errorMsg = `Azure Anthropic ${response.status}: ${errorText.substring(0, 300)}`;
    lastError = new Error(errorMsg);

    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_RETRIES) {
      log('ERROR', 'ANTHROPIC', `${errorMsg} (no retry)`);
      throw lastError;
    }

    const delay = backoffDelayMs(attempt, response.headers.get('retry-after'));
    log(
      'WARN',
      'ANTHROPIC',
      `${response.status} on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${delay}ms`,
    );
    await sleep(delay);
  }

  // Defensive — loop above always returns or throws on the final iteration.
  throw lastError ?? new Error('Azure Anthropic call failed with no recorded error');
}

// =====================================================================
// Grounding-specific helper
// =====================================================================

export type FieldVerdict = 'pass' | 'weak' | 'fail';

export interface SectionVerdict {
  verdict: FieldVerdict;
  confidence: number;
  reasoning: string;
  evidence_pages?: number[];
  repair_instruction: string | null;
}

export interface GroundingVerdict {
  overall_verdict: FieldVerdict;
  sections: Record<string, SectionVerdict>;
  iteration: number;
}

export type GroundingSourceBlock =
  | { kind: 'pdf'; mediaType: 'application/pdf'; base64: string }
  | { kind: 'text'; text: string };

/**
 * Build the JSON tool schema mirroring EXTRACTION_SCHEMA top-level field names.
 * Claude returns structured JSON via forced tool use so we don't have to parse
 * markdown-fenced strings.
 */
function buildGroundingTool(fieldNames: string[]): AnthropicTool {
  const sectionItemSchema = {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'weak', 'fail'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reasoning: { type: 'string', description: 'One or two sentences explaining the verdict.' },
      evidence_pages: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description: 'Page numbers (1-indexed) from the PDF that support the verdict.',
      },
      repair_instruction: {
        type: ['string', 'null'],
        description:
          'For weak/fail verdicts, a specific natural-language instruction for the extraction model on what to fix or re-extract. Null for pass verdicts.',
      },
    },
    required: ['verdict', 'confidence', 'reasoning', 'repair_instruction'],
  };

  const sectionsProps: Record<string, unknown> = {};
  for (const name of fieldNames) sectionsProps[name] = sectionItemSchema;

  return {
    name: 'report_grounding_verdict',
    description:
      'Return per-section grounding verdicts for the demand-packet report against the source PDF. Use evidence from the PDF to grade each section as pass (complete and correct), weak (present but incomplete or low-confidence), or fail (missing, wrong, or contradicted by the source). Provide a specific repair_instruction for any weak or fail verdict.',
    input_schema: {
      type: 'object',
      properties: {
        overall_verdict: { type: 'string', enum: ['pass', 'weak', 'fail'] },
        sections: {
          type: 'object',
          properties: sectionsProps,
          required: fieldNames,
        },
        iteration: { type: 'integer', minimum: 0 },
      },
      required: ['overall_verdict', 'sections', 'iteration'],
    },
  };
}

function buildGroundingSystemPrompt(rubric: string): ContentBlock[] {
  return [
    {
      type: 'text',
      text: `You are a grounding evaluator for an insurance-claim demand-packet review pipeline. Another model (Gemini) extracted a structured report from the attached source PDF. Your job is to verify each report section against the PDF and grade it.

Verdict rules:
- pass: section is present, complete, and consistent with the PDF.
- weak: section is partially correct — missing items, low confidence, or includes minor inaccuracies that should be revisited.
- fail: section is missing, wrong, contradicted by the PDF, or fabricated.

For every weak or fail verdict you MUST provide a concrete repair_instruction telling the extraction model exactly what to look for and where (e.g. cite a page or section name). For pass verdicts, repair_instruction must be null.

Overall verdict is fail if any required section is fail; weak if any section is weak; otherwise pass.

You MUST respond by invoking the report_grounding_verdict tool. Do not return plain text.

Schema and field-by-field rubric:
${rubric}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

function buildUserContent(
  source: GroundingSourceBlock,
  geminiOutput: unknown,
  iteration: number,
  priorVerdict?: GroundingVerdict,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (source.kind === 'pdf') {
    blocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: source.base64 },
      cache_control: { type: 'ephemeral' },
    });
  } else {
    blocks.push({
      type: 'text',
      text: `SOURCE TEXT (PDF too large to send directly — text extracted by the pipeline):\n\n${source.text}`,
      cache_control: { type: 'ephemeral' },
    });
  }

  const evalJson = JSON.stringify(geminiOutput, null, 2);
  const safeEval = evalJson.length > 80000 ? evalJson.substring(0, 80000) + '\n...[truncated]' : evalJson;

  let priorBlock = '';
  if (priorVerdict) {
    priorBlock = `\n\nPRIOR ITERATION ${priorVerdict.iteration} VERDICT (the extraction model was asked to repair these sections — verify whether the fixes landed):\n${JSON.stringify(priorVerdict.sections, null, 2)}`;
  }

  blocks.push({
    type: 'text',
    text: `Iteration: ${iteration}\n\nEXTRACTED REPORT TO EVALUATE:\n${safeEval}${priorBlock}\n\nGrade each section using the report_grounding_verdict tool.`,
  });

  return blocks;
}

/**
 * Call Claude to ground/evaluate a Gemini extraction against the source PDF.
 * Uses forced tool use so the return value is always valid structured JSON.
 *
 * Throws if Claude returns no tool_use block (caller treats as a non-fatal
 * grounding failure and falls back to the existing pipeline results).
 */
export async function callAnthropicForGrounding(
  source: GroundingSourceBlock,
  geminiOutput: unknown,
  fieldNames: string[],
  rubric: string,
  iteration: number,
  priorVerdict?: GroundingVerdict,
): Promise<{ verdict: GroundingVerdict; usage: AnthropicUsage }> {
  const tool = buildGroundingTool(fieldNames);
  const system = buildGroundingSystemPrompt(rubric);
  const userContent = buildUserContent(source, geminiOutput, iteration, priorVerdict);

  const response = await callAnthropic(
    [{ role: 'user', content: userContent }],
    {
      maxTokens: 4096,
      temperature: 0,
      system,
      tools: [tool],
      toolChoice: { type: 'tool', name: tool.name },
    },
  );

  const toolUse = response.content.find((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
  if (!toolUse) {
    throw new Error(`Anthropic returned no tool_use block (stop_reason=${response.stop_reason})`);
  }

  const verdict = toolUse.input as GroundingVerdict;
  if (!verdict?.sections || !verdict?.overall_verdict) {
    throw new Error('Anthropic tool_use payload missing required fields (sections / overall_verdict)');
  }

  return { verdict, usage: response.usage };
}
