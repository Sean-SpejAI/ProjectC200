// Gemini operations on the standard Google AI (generativelanguage) API.
//
// Auth is a single API key (GEMINI_API_KEY) sent as `x-goog-api-key` — no GCP
// service account / OAuth, no project or region. Two PDF input paths are used
// by analyze-claim-document:
//   1. inlineData (base64 bytes in the request body) — for PDFs ≤ the inline
//      request ceiling (the standard API caps a single request near ~20 MB; we
//      route anything over GEMINI_FILE_API_THRESHOLD to the Files API instead).
//   2. fileData.fileUri via the Files API — for larger PDFs. The PDF is
//      uploaded (files.upload), referenced by its returned URI for one
//      generateContent call, then deleted (files.delete). This replaces the
//      old GCS + Vertex `gs://` path; unlike SA-OAuth tokens, an API key CAN
//      use the Files API.

import { GEMINI_PDF_INFERENCE_LIMIT, PRO_MODEL_THRESHOLD } from './types.ts';
import { log, logTiming } from './utils.ts';

const API_BASE = 'https://generativelanguage.googleapis.com';

function getApiKey(): string {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is not configured');
  return key;
}

// generativelanguage addresses models as `models/<id>`.
function modelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// =====================================================================
// Files API — upload large PDFs and reference them by URI.
// =====================================================================

/**
 * Upload a PDF to the Gemini Files API and return its `{ uri, name }`. The uri
 * goes into a fileData part; the name (e.g. "files/abc123") is used to delete
 * it afterward. Uses the resumable upload protocol (reliable for binary), then
 * polls until the file is ACTIVE.
 */
export async function uploadPdfToGeminiFiles(
  buffer: ArrayBuffer | Uint8Array,
  displayName: string,
): Promise<{ uri: string; name: string }> {
  const startTime = Date.now();
  const key = getApiKey();
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const numBytes = bytes.byteLength;
  const sizeMB = (numBytes / 1024 / 1024).toFixed(2);
  log('INFO', 'GEMINI_FILES', `Uploading PDF to Files API (${sizeMB} MB)`, { displayName });

  // 1. Start a resumable upload session.
  const startResp = await fetch(`${API_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(numBytes),
      'X-Goog-Upload-Header-Content-Type': 'application/pdf',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!startResp.ok) {
    const t = await startResp.text();
    throw new Error(`Files API start failed: ${startResp.status} - ${t.substring(0, 300)}`);
  }
  const uploadUrl =
    startResp.headers.get('X-Goog-Upload-URL') || startResp.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Files API start returned no upload URL');

  // 2. Upload the bytes and finalize in one shot.
  const upResp = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(numBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: bytes,
  });
  if (!upResp.ok) {
    const t = await upResp.text();
    throw new Error(`Files API upload failed: ${upResp.status} - ${t.substring(0, 300)}`);
  }
  const info = await upResp.json();
  let file = info.file;
  if (!file?.name || !file?.uri) throw new Error('Files API upload returned no file uri/name');

  // 3. Poll until ACTIVE (PDFs are usually immediate; bound the wait).
  let state: string = file.state;
  const deadline = Date.now() + 60_000;
  while (state === 'PROCESSING' && Date.now() < deadline) {
    await sleep(1500);
    const g = await fetch(`${API_BASE}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': key } });
    if (!g.ok) break;
    file = await g.json();
    state = file.state;
  }
  if (state !== 'ACTIVE') {
    throw new Error(`Files API: file did not become ACTIVE (state=${state})`);
  }

  logTiming('GEMINI_FILES', 'Upload', startTime);
  log('INFO', 'GEMINI_FILES', `✅ Uploaded ${file.name}`, { uri: file.uri });
  return { uri: file.uri, name: file.name };
}

export async function deleteGeminiFile(name: string): Promise<void> {
  try {
    const key = getApiKey();
    const r = await fetch(`${API_BASE}/v1beta/${name}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': key },
    });
    if (r.ok || r.status === 404) {
      log('INFO', 'GEMINI_FILES', `✅ Deleted ${name}`);
    } else {
      log('WARN', 'GEMINI_FILES', `Delete returned ${r.status} for ${name}`);
    }
  } catch (error) {
    log('WARN', 'GEMINI_FILES', `Failed to delete ${name} (file will expire on its own)`, error);
  }
}

// =====================================================================
// generateContent core
// =====================================================================

export interface GenerateOptions {
  /** Override the default model (e.g. force flash for cheap classification). */
  model?: string;
  /** OpenAPI-3.0 schema for structured JSON output. When set, also forces responseMimeType=application/json. */
  responseSchema?: Record<string, unknown>;
  /** Override default temperature. */
  temperature?: number;
  /** Override default maxOutputTokens. */
  maxOutputTokens?: number;
}

// Gemini contents-API "parts" shape. Inline data is base64-encoded bytes
// (PDF or image); fileData uses a Files API URI; text is plain text.
export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } };

function buildGenerationConfig(opts: GenerateOptions): Record<string, unknown> {
  // T=0 by default — structured-JSON extraction (the dominant use case here)
  // wants deterministic output. Callers needing narrative variation pass a
  // non-zero temperature via opts.
  const cfg: Record<string, unknown> = {
    temperature: opts.temperature ?? 0,
    maxOutputTokens: opts.maxOutputTokens ?? 32768,
  };
  if (opts.responseSchema) {
    cfg.responseMimeType = 'application/json';
    cfg.responseSchema = opts.responseSchema;
  }
  return cfg;
}

/**
 * One generateContent call against the standard Gemini API, with transient
 * retry/backoff and a per-attempt timeout. Returns the model's text response.
 */
async function callGenerate(
  model: string,
  parts: GeminiPart[],
  systemPrompt: string,
  opts: GenerateOptions,
  logTag: string,
  maxAttempts: number,
  perAttemptTimeoutMs: number,
): Promise<string> {
  const startTime = Date.now();
  const key = getApiKey();

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig: buildGenerationConfig(opts),
  };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  const requestBody = JSON.stringify(body);
  const url = `${API_BASE}/v1beta/${modelPath(model)}:generateContent`;

  log('INFO', logTag, `Generating content via Gemini API`, {
    model,
    partCount: parts.length,
    hasResponseSchema: !!opts.responseSchema,
  });

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perAttemptTimeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (netErr) {
      lastError = netErr instanceof Error ? netErr : new Error(String(netErr));
      const timedOut = lastError.name === 'AbortError';
      log('WARN', logTag, `Network error attempt ${attempt}/${maxAttempts}${timedOut ? ' (timeout)' : ''}: ${lastError.message}${attempt < maxAttempts ? ' — retrying' : ''}`);
      if (attempt < maxAttempts) { await sleep(3000 * attempt); continue; }
      throw new Error(`Gemini request failed after ${maxAttempts} attempts: ${lastError.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 400 && errorText.includes('INVALID_ARGUMENT')) {
        // Permanent — the document/request itself is rejected. Don't retry.
        throw new Error(`Gemini rejected the request: ${errorText.substring(0, 300)}`);
      }
      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        log('WARN', logTag, `Transient ${response.status} attempt ${attempt}/${maxAttempts} — retrying`);
        lastError = new Error(`Gemini ${response.status}: ${errorText.substring(0, 200)}`);
        await sleep(3000 * attempt);
        continue;
      }
      throw new Error(`Gemini ${response.status}: ${errorText.substring(0, 500)}`);
    }

    const result = await response.json();
    if (result.error) throw new Error(`Gemini error: ${result.error.message}`);
    if (!result.candidates || result.candidates.length === 0) {
      const blockReason = result.promptFeedback?.blockReason || 'Unknown';
      throw new Error(`Gemini returned no results. Block reason: ${blockReason}.`);
    }
    const candidate = result.candidates[0];
    if (candidate.finishReason === 'SAFETY') {
      throw new Error('Response blocked by safety filters.');
    }
    const textContent = candidate.content?.parts?.map((p: { text?: string }) => p.text || '').join('') || '';
    if (!textContent) {
      throw new Error(`Gemini returned no text content. Finish reason: ${candidate.finishReason || 'unknown'}`);
    }

    logTiming(logTag, 'API call', startTime);
    log('INFO', logTag, `✅ Content generated`, { responseLength: textContent.length, attempts: attempt });
    return textContent;
  }

  throw lastError ?? new Error('Gemini generation failed');
}

/**
 * Generate content from a Files-API PDF (the large-PDF path). Mirrors the old
 * Vertex gs:// path: pick pro for big files unless overridden, 3 attempts with
 * a generous per-attempt timeout (dense scanned medical PDFs are slow).
 */
export async function generateWithGeminiFile(
  fileUri: string,
  systemPrompt: string,
  userPrompt: string,
  fileSize: number,
  opts: GenerateOptions = {},
): Promise<string> {
  if (fileSize > GEMINI_PDF_INFERENCE_LIMIT) {
    const limitMB = (GEMINI_PDF_INFERENCE_LIMIT / 1024 / 1024).toFixed(0);
    throw new Error(`PDF file (${(fileSize / 1024 / 1024).toFixed(1)} MB) exceeds Gemini's ${limitMB} MB processing limit.`);
  }
  const model = opts.model ?? (fileSize > PRO_MODEL_THRESHOLD ? 'gemini-2.5-pro' : 'gemini-2.5-flash');
  const parts: GeminiPart[] = [
    { fileData: { mimeType: 'application/pdf', fileUri } },
    { text: userPrompt },
  ];
  return callGenerate(model, parts, systemPrompt, opts, 'GEMINI_GENERATE', 3, 150_000);
}

/**
 * Generate content for inline (non-fileData) inputs: small-PDF base64,
 * image-vision, and text-only. 5 attempts; standard per-attempt timeout.
 */
export async function generateWithInlineContent(
  parts: GeminiPart[],
  systemPrompt: string,
  model: string,
  opts: GenerateOptions = {},
): Promise<string> {
  return callGenerate(model, parts, systemPrompt, opts, 'GEMINI_INLINE', 5, 120_000);
}

// =====================================================================
// Pass 0 — Document classification (Phase 1.1)
// =====================================================================

/**
 * One classification entry. A document can have several (a 200-page bundle
 * with correspondence on pp.1-19, medical records on pp.20-45, bills on pp.46-60
 * yields three entries).
 */
export interface ClassificationEntry {
  type: string;        // member of DOCUMENT_TYPE_VOCAB
  pageStart: number;   // 1-indexed, inclusive
  pageEnd: number;     // 1-indexed, inclusive
  confidence: number;  // 0-1
}

const CLASSIFIER_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: [
              'correspondence', 'fnol', 'declarations_page', 'demand_letter',
              'hospital_facesheet', 'er_record', 'physician_notes', 'operative_report',
              'radiology_report', 'physical_therapy', 'medical_signin_slip',
              'medical_record', 'bills', 'police_report', 'pharmacy_records', 'other',
            ],
          },
          pageStart:  { type: 'integer' },
          pageEnd:    { type: 'integer' },
          confidence: { type: 'number' },
        },
        required: ['type', 'pageStart', 'pageEnd', 'confidence'],
      },
    },
  },
  required: ['classifications'],
};

const CLASSIFIER_SYSTEM_PROMPT = `You are a document classifier for an insurance claim analysis pipeline.

Your job is to partition the PDF into one or more contiguous page ranges, each labeled with one of these document types:

- correspondence: letters, emails, status updates, general claim communication
- fnol: First Notice of Loss form
- declarations_page: insurance policy declarations
- demand_letter: legal demand/representation letter from a law firm (attorney letterhead + settlement demand). Often the COVER/FRONT pages of a much larger packet that also bundles the claimant's medical records and bills behind it — label ONLY the letter pages demand_letter, and label the attachments behind it by their own types.
- hospital_facesheet: hospital admission/registration page with patient demographics
- er_record: emergency room visit record (triage, ER physician notes)
- physician_notes: outpatient physician notes (history, exam, assessment, plan)
- operative_report: surgical procedure narrative
- radiology_report: imaging studies (X-ray, MRI, CT, ultrasound) with findings/impression
- physical_therapy: PT visit notes / treatment plans
- medical_signin_slip: chiropractic/PT visit slips with CPT codes and treatment areas
- medical_record: a broader medical record bundle that isn't more specific (admission history, multi-visit chart)
- bills: itemized medical bills, EOBs, billing statements
- police_report: incident/accident report from law enforcement
- pharmacy_records: prescription fills, medication histories
- other: anything that doesn't fit above

CRITICAL RULES:
1. Read the WHOLE document. Medical content frequently appears 20+ pages into a bundle behind correspondence cover sheets. A 3-page peek would miss it.
2. Each entry MUST cover a contiguous page range (pageStart through pageEnd, both inclusive, 1-indexed).
3. Entries should NOT overlap and SHOULD cover every page of the document.
4. If you can't tell, use type "other" — never invent a more specific type without supporting content.
5. confidence is 0-1, your own confidence in the type assignment for that range.
6. Single-type documents return a single entry spanning page 1 to the last page.
7. DEMAND PACKETS: when the document opens with a law-firm demand/representation letter (firm letterhead, "demand", "settle", liability/injuries/damages sections, attorney signature) followed by attached medical records and bills, you MUST emit a SEPARATE \`demand_letter\` range for the letter pages — do NOT label the whole packet by its bulkiest (usually medical) section. The demand letter is high-signal (it carries attorney/firm, time-limit, demand amount, claimant identity) and must never be swallowed into a medical or "other" range.

Return STRICTLY the JSON shape requested.`;

const CLASSIFIER_USER_PROMPT = `Classify this PDF. Return the list of {type, pageStart, pageEnd, confidence} entries that partition the document.`;

/**
 * Run the Pass 0 classifier on a Files-API PDF. Always uses gemini-2.5-flash
 * for cost. Use `classifyDocumentFromFile` when the PDF is already uploaded for
 * analyze; use `classifyDocumentInline` for ≤ inline-threshold PDFs / smoke tests.
 */
export async function classifyDocumentFromFile(
  fileUri: string,
  fileSize: number,
): Promise<ClassificationEntry[]> {
  const raw = await generateWithGeminiFile(
    fileUri,
    CLASSIFIER_SYSTEM_PROMPT,
    CLASSIFIER_USER_PROMPT,
    fileSize,
    {
      model: 'gemini-2.5-flash',
      responseSchema: CLASSIFIER_RESPONSE_SCHEMA,
      temperature: 0,
      maxOutputTokens: 4096,
    },
  );
  return parseClassifierResponse(raw);
}

export async function classifyDocumentInline(
  pdfBase64: string,
): Promise<ClassificationEntry[]> {
  const parts: GeminiPart[] = [
    { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
    { text: CLASSIFIER_USER_PROMPT },
  ];
  const raw = await generateWithInlineContent(parts, CLASSIFIER_SYSTEM_PROMPT, 'gemini-2.5-flash', {
    responseSchema: CLASSIFIER_RESPONSE_SCHEMA,
    temperature: 0.1,
    maxOutputTokens: 4096,
  });
  return parseClassifierResponse(raw);
}

function parseClassifierResponse(raw: string): ClassificationEntry[] {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.classifications)) {
      throw new Error('Classifier response missing classifications array');
    }
    const out: ClassificationEntry[] = [];
    for (const entry of parsed.classifications) {
      if (
        typeof entry?.type === 'string' &&
        typeof entry?.pageStart === 'number' &&
        typeof entry?.pageEnd === 'number' &&
        typeof entry?.confidence === 'number'
      ) {
        out.push({
          type: entry.type,
          pageStart: entry.pageStart,
          pageEnd: entry.pageEnd,
          confidence: entry.confidence,
        });
      }
    }
    if (out.length === 0) {
      throw new Error('Classifier returned no usable entries');
    }
    return out;
  } catch (err) {
    log('ERROR', 'CLASSIFY', `Failed to parse classifier response: ${err instanceof Error ? err.message : String(err)}`);
    // Graceful fallback so a misbehaving classifier doesn't block extraction.
    // The doc gets typed as `other` covering the whole file; downstream code
    // falls back to the bare `required` flag (i.e. old behaviour).
    return [{ type: 'other', pageStart: 1, pageEnd: 1, confidence: 0.0 }];
  }
}

/**
 * Pick the "primary" classification entry — the one with the largest page coverage.
 * Used to populate the legacy `claim_documents.document_type` TEXT column for
 * back-compat with the UI and Sor metadata override.
 */
export function pickPrimaryType(entries: ClassificationEntry[]): string {
  if (entries.length === 0) return 'other';
  let best = entries[0];
  let bestSpan = best.pageEnd - best.pageStart + 1;
  for (const e of entries.slice(1)) {
    const span = e.pageEnd - e.pageStart + 1;
    if (span > bestSpan) { best = e; bestSpan = span; }
  }
  return best.type;
}
