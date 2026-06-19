// Gemini-on-Vertex-AI operations.
//
// Two PDF input paths are used by analyze-claim-document:
//   1. inlineData (base64-encoded bytes in the request body) — for PDFs ≤ 5 MB.
//   2. fileData.fileUri with a gs:// URI — for PDFs > 5 MB. The PDF is uploaded
//      to a GCS bucket (`GCP_GCS_BUCKET`, default `spej-claims-vertex-uploads`)
//      that the Vertex AI service account has Object Admin on, then deleted
//      after analysis. Arbitrary HTTPS URLs in fileData.fileUri are capped at
//      15 MB by Vertex; gs:// allows up to 2 GB. We don't use the Google AI
//      Files API on generativelanguage.googleapis.com — that endpoint rejects
//      SA OAuth tokens with `ACCESS_TOKEN_SCOPE_INSUFFICIENT`.

import { GEMINI_PDF_INFERENCE_LIMIT, PRO_MODEL_THRESHOLD } from './types.ts';
import { log, logTiming } from './utils.ts';
import { getAccessToken, getProjectId, getRegion } from './vertex-auth.ts';

const DEFAULT_GCS_BUCKET = 'spej-claims-vertex-uploads';

function getGcsBucket(): string {
  return Deno.env.get('GCP_GCS_BUCKET') || DEFAULT_GCS_BUCKET;
}

export async function uploadPdfToGcs(
  buffer: ArrayBuffer | Uint8Array,
  objectName: string,
): Promise<string> {
  const startTime = Date.now();
  const bucket = getGcsBucket();
  const token = await getAccessToken();
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  const sizeMB = (bytes.byteLength / 1024 / 1024).toFixed(2);
  log('INFO', 'GCS_UPLOAD', `Uploading to gs://${bucket}/${objectName}`, { sizeMB });

  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/pdf',
    },
    body: bytes,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GCS upload failed: ${response.status} - ${errorText.substring(0, 300)}`);
  }

  const gsUri = `gs://${bucket}/${objectName}`;
  logTiming('GCS_UPLOAD', 'Upload', startTime);
  log('INFO', 'GCS_UPLOAD', `✅ Uploaded to ${gsUri}`);
  return gsUri;
}

export async function deleteGcsObject(objectName: string): Promise<void> {
  const bucket = getGcsBucket();
  try {
    const token = await getAccessToken();
    const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok || response.status === 404) {
      log('INFO', 'GCS_DELETE', `✅ Deleted gs://${bucket}/${objectName}`);
    } else {
      log('WARN', 'GCS_DELETE', `Delete returned ${response.status} for ${objectName}`);
    }
  } catch (error) {
    log('WARN', 'GCS_DELETE', `Failed to delete ${objectName} (object will persist)`, error);
  }
}

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

export async function generateWithVertexFile(
  gcsUri: string,
  systemPrompt: string,
  userPrompt: string,
  fileSize: number,
  opts: GenerateOptions = {},
): Promise<string> {
  const startTime = Date.now();
  const token = await getAccessToken();

  if (fileSize > GEMINI_PDF_INFERENCE_LIMIT) {
    const limitMB = (GEMINI_PDF_INFERENCE_LIMIT / 1024 / 1024).toFixed(0);
    throw new Error(`PDF file (${(fileSize / 1024 / 1024).toFixed(1)} MB) exceeds Gemini's ${limitMB} MB processing limit.`);
  }

  const model = opts.model ?? (fileSize > PRO_MODEL_THRESHOLD ? 'gemini-2.5-pro' : 'gemini-2.5-flash');
  const region = getRegion();
  const projectId = getProjectId();

  log('INFO', 'GEMINI_GENERATE', `Generating content with Vertex AI`, { model, gcsUri, region, projectId, hasResponseSchema: !!opts.responseSchema });

  // T=0 by default — structured-JSON extraction tasks (the dominant use case
  // here) want deterministic output. Callers that need narrative variation
  // (e.g. synthesis) pass an explicit non-zero temperature via opts.
  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0,
    maxOutputTokens: opts.maxOutputTokens ?? 32768,
  };
  if (opts.responseSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = opts.responseSchema;
  }

  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;
  const requestBody = JSON.stringify({
    contents: [{
      role: 'user',
      parts: [
        { fileData: { mimeType: 'application/pdf', fileUri: gcsUri } },
        { text: userPrompt }
      ]
    }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig,
  });

  // The gs:// fileData path was previously a single, un-retried fetch — a
  // transient connection reset / 5xx / 429 (common on a long inference over a
  // big PDF) failed the whole document with no recovery, leaving it stuck.
  // Retry transient failures with backoff, and bound each attempt with a
  // timeout so a hung connection aborts and retries rather than stalling until
  // the 400s worker wall-clock kills the invocation (which leaves no error).
  const MAX_ATTEMPTS = 3;
  // 150 s per attempt: dense scanned-medical PDFs (e.g. 25-page browser-split
  // chunks) routinely need >90 s for a single Vertex inference, so a 90 s cap
  // aborted them on every attempt and failed the doc. 150 s still leaves room
  // inside the 400 s worker wall-clock (only Pass 0/Pass 1 send the full PDF
  // here; later passes are text-only).
  const PER_ATTEMPT_TIMEOUT_MS = 150_000;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (netErr) {
      // Connection reset / DNS / abort(timeout) — all transient. Retry.
      lastError = netErr instanceof Error ? netErr : new Error(String(netErr));
      const timedOut = lastError.name === 'AbortError';
      log('WARN', 'GEMINI_GENERATE', `Network error attempt ${attempt}/${MAX_ATTEMPTS}${timedOut ? ' (timeout)' : ''}: ${lastError.message}${attempt < MAX_ATTEMPTS ? ' — retrying' : ''}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 3000 * attempt)); continue; }
      throw new Error(`Vertex AI request failed after ${MAX_ATTEMPTS} attempts: ${lastError.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 400 && errorText.includes('INVALID_ARGUMENT')) {
        // Permanent — the document/request itself is rejected. Don't retry.
        throw new Error(`Vertex AI rejected the document: ${errorText.substring(0, 300)}`);
      }
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
        log('WARN', 'GEMINI_GENERATE', `Transient ${response.status} attempt ${attempt}/${MAX_ATTEMPTS} — retrying`);
        lastError = new Error(`Vertex AI ${response.status}: ${errorText.substring(0, 200)}`);
        await new Promise(r => setTimeout(r, 3000 * attempt));
        continue;
      }
      throw new Error(`Vertex AI ${response.status}: ${errorText.substring(0, 500)}`);
    }

    const result = await response.json();
    if (result.error) throw new Error(`Vertex AI error: ${result.error.message}`);
    if (!result.candidates || result.candidates.length === 0) {
      const blockReason = result.promptFeedback?.blockReason || 'Unknown';
      throw new Error(`Vertex AI returned no results. Block reason: ${blockReason}.`);
    }
    const candidate = result.candidates[0];
    if (candidate.finishReason === 'SAFETY') {
      throw new Error('Response blocked by safety filters.');
    }
    const textContent = candidate.content?.parts?.[0]?.text;
    if (!textContent) {
      throw new Error(`Vertex AI returned no text content. Finish reason: ${candidate.finishReason || 'unknown'}`);
    }

    logTiming('GEMINI_GENERATE', 'API call', startTime);
    log('INFO', 'GEMINI_GENERATE', `✅ Content generated`, { responseLength: textContent.length, attempts: attempt });
    return textContent;
  }

  throw lastError ?? new Error('Vertex AI generation failed');
}

// Gemini contents-API "parts" shape. Inline data is base64-encoded bytes
// (PDF or image); fileData uses a gs:// URI; text is plain text.
export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } };

/**
 * Generate content with Vertex AI for inline (non-fileData) inputs.
 * Used by the small-PDF, image-vision, and text-fallback branches of
 * performAnalysis — anywhere we don't go through the gs:// fileData path.
 * Returns the model's text response, retrying transient 5xx / 429 errors.
 */
export async function generateWithInlineContent(
  parts: GeminiPart[],
  systemPrompt: string,
  model: string,
  opts: GenerateOptions = {},
): Promise<string> {
  const startTime = Date.now();
  const token = await getAccessToken();
  const region = getRegion();
  const projectId = getProjectId();

  log('INFO', 'GEMINI_INLINE', `Generating content via Vertex AI`, { model, region, projectId, partCount: parts.length, hasResponseSchema: !!opts.responseSchema });

  // T=0 by default — structured-JSON extraction tasks (the dominant use case
  // here) want deterministic output. Callers that need narrative variation
  // (e.g. synthesis) pass an explicit non-zero temperature via opts.
  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0,
    maxOutputTokens: opts.maxOutputTokens ?? 32768,
  };
  if (opts.responseSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = opts.responseSchema;
  }

  const body = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig,
  };

  const maxAttempts = 5;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(
      `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 429) {
        lastError = new Error('Rate limit exceeded.');
      } else if (response.status === 400 && errorText.includes('INVALID_ARGUMENT')) {
        throw new Error(`Vertex AI rejected the request: ${errorText.substring(0, 300)}`);
      } else if (response.status >= 500 && attempt < maxAttempts) {
        log('WARN', 'GEMINI_INLINE', `Transient ${response.status} on attempt ${attempt} — retrying`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      } else {
        throw new Error(`Vertex AI ${response.status}: ${errorText.substring(0, 300)}`);
      }
      if (attempt === maxAttempts) throw lastError;
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }

    const result = await response.json();
    if (result.error) throw new Error(`Vertex AI error: ${result.error.message}`);
    if (!result.candidates || result.candidates.length === 0) {
      const blockReason = result.promptFeedback?.blockReason || 'Unknown';
      throw new Error(`Vertex AI returned no results. Block reason: ${blockReason}.`);
    }
    const candidate = result.candidates[0];
    if (candidate.finishReason === 'SAFETY') {
      throw new Error('Response blocked by safety filters.');
    }
    const textContent = candidate.content?.parts?.[0]?.text;
    if (!textContent) {
      throw new Error(`Vertex AI returned no text content. Finish reason: ${candidate.finishReason || 'unknown'}`);
    }
    logTiming('GEMINI_INLINE', 'API call', startTime);
    log('INFO', 'GEMINI_INLINE', `✅ Content generated`, { responseLength: textContent.length });
    return textContent;
  }

  throw lastError ?? new Error('Vertex AI inline generation failed');
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
 * Run the Pass 0 classifier. Routes through the same gs:// vs inline path as
 * Pass 1 (GCS for >5 MB), always uses gemini-2.5-flash for cost reasons.
 *
 * Use `classifyDocumentFromGcs` when the PDF is already in GCS for analyze;
 * use `classifyDocumentInline` for ≤5 MB PDFs / smoke tests.
 */
export async function classifyDocumentFromGcs(
  gcsUri: string,
  fileSize: number,
): Promise<ClassificationEntry[]> {
  const raw = await generateWithVertexFile(
    gcsUri,
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
