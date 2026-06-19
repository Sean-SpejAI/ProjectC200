// Pass 2: Gap-Fill Extraction for Multi-Pass Extraction Pipeline
// Performs focused extraction on fields that were empty/low-confidence after Pass 1

import { log } from './utils.ts';
import {
  DocumentClassification,
  EXTRACTION_SCHEMA,
  FieldDefinition,
  getFieldsForRetry,
  isFieldRequiredFor,
  setNestedValue,
  getNestedValue
} from './extraction-schema.ts';
import { ExtractedTextStructure } from './text-extraction.ts';
import { getAccessToken, getProjectId, getRegion } from './vertex-auth.ts';

/**
 * Perform gap-fill extraction for missing or low-quality fields
 *
 * Pass 2 Strategy:
 * - Identify fields that are empty/incomplete from Pass 1
 * - For each missing field, create a FOCUSED prompt using section-specific text
 * - Send targeted AI requests (not entire document) for higher accuracy
 * - Merge results back into initial analysis
 */
export async function performGapFillExtraction(
  initialAnalysis: any,
  extractedText: ExtractedTextStructure,
  documentId: string,
  correctiveGuidance?: Record<string, string>,
  classifications?: DocumentClassification[] | null,
): Promise<any> {
  // If corrective guidance is supplied (Pass 5 grounding repair), target ONLY
  // the fields named in the guidance regardless of their current value — the
  // Anthropic evaluator may have flagged a field that was populated but wrong.
  // Otherwise fall back to the empty-field heuristic — but only for fields
  // actually required for THIS doc's classifications, so we don't ask for
  // medical fields on correspondence.
  let fieldsToRetry: FieldDefinition[];
  if (correctiveGuidance && Object.keys(correctiveGuidance).length > 0) {
    fieldsToRetry = Object.keys(correctiveGuidance)
      .map(name => EXTRACTION_SCHEMA[name])
      .filter((def): def is FieldDefinition => def !== undefined);
    log('INFO', 'GAP_FILL', `Corrective-guidance mode: targeting ${fieldsToRetry.length} flagged fields`);
  } else {
    fieldsToRetry = getFieldsForRetry(initialAnalysis, classifications);
  }

  if (fieldsToRetry.length === 0) {
    log('INFO', 'GAP_FILL', 'No fields require gap-fill, skipping');
    return initialAnalysis;
  }

  log('INFO', 'GAP_FILL', `Gap-fill targeting ${fieldsToRetry.length} fields: ${fieldsToRetry.map(f => f.name).join(', ')}`);

  const gapFillResults: Record<string, any> = {};

  for (const field of fieldsToRetry) {
    try {
      log('INFO', 'GAP_FILL', `Extracting field: ${field.name}`);

      const guidance = correctiveGuidance?.[field.name];
      const focusedPrompt = buildFocusedPrompt(field, extractedText, initialAnalysis, guidance, classifications);

      const result = await callAIForField(field, focusedPrompt, extractedText);

      if (result !== null && result !== undefined) {
        gapFillResults[field.name] = result;
        log('INFO', 'GAP_FILL', `✅ Extracted ${field.name}: ${JSON.stringify(result).substring(0, 100)}...`);
      } else {
        log('WARN', 'GAP_FILL', `❌ Failed to extract ${field.name}`);
      }
    } catch (error) {
      log('ERROR', 'GAP_FILL', `Error extracting ${field.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // When repairing under corrective guidance the evaluator wants the new value
  // to replace the old one, even if the old one is non-empty. Otherwise stick
  // to fill-empty-only semantics so we never overwrite Pass 1 data accidentally.
  const merged = correctiveGuidance
    ? overwriteGapFillResults(initialAnalysis, gapFillResults)
    : mergeGapFillResults(initialAnalysis, gapFillResults);

  log('INFO', 'GAP_FILL', `Gap-fill complete: ${Object.keys(gapFillResults).length}/${fieldsToRetry.length} fields filled`);

  return merged;
}

/**
 * Build a focused prompt for a specific field
 * Uses extraction hints and section-specific text for targeted extraction
 */
function buildFocusedPrompt(
  field: FieldDefinition,
  extractedText: ExtractedTextStructure,
  initialAnalysis: any,
  correctiveGuidance?: string,
  classifications?: DocumentClassification[] | null,
): string {
  // Determine relevant section based on field name
  const sectionKey = getSectionForField(field.name);
  const relevantSection = extractedText.sections[sectionKey];

  // Get section text or fall back to full document text
  let contextText = '';
  if (relevantSection && relevantSection.text) {
    contextText = relevantSection.text;
    log('DEBUG', 'GAP_FILL', `Using ${sectionKey} section (${contextText.length} chars) for ${field.name}`);
  } else {
    // Fallback: use all page text
    contextText = extractedText.pages.map(p => p.text).join('\n\n');
    log('DEBUG', 'GAP_FILL', `Using full document text (${contextText.length} chars) for ${field.name}`);
  }

  // Build field-specific extraction instructions
  const instructions = getFieldInstructions(field);

  // If the grounding evaluator flagged this field, append its feedback verbatim.
  // The evaluator usually cites a page or sub-section the original extraction
  // missed — load-bearing for the repair loop to converge.
  const feedbackBlock = correctiveGuidance
    ? `\n## PRIOR EVALUATION FEEDBACK (from grounding pass — address this specifically):\n${correctiveGuidance}\n`
    : '';

  return `FOCUSED EXTRACTION TASK: ${field.name}

CONTEXT: Previous extraction pass missed or returned low confidence for this field.${feedbackBlock}

FIELD REQUIREMENTS:
- Type: ${field.type}
- Required: ${isFieldRequiredFor(field, classifications)}
- Extraction Hints: ${field.extractionHints.join(', ')}

${instructions}

DOCUMENT TEXT (relevant sections):
${contextText.substring(0, 15000)} ${contextText.length > 15000 ? '...[truncated for length]' : ''}

INSTRUCTIONS:
${getExtractionDirective(field)}

Return ONLY the extracted data for this field in valid JSON format. Do not include comments in the JSON.
Format: { "${field.name}": <extracted_value> }`;
}

/**
 * Get the section key for a given field name
 */
function getSectionForField(fieldName: string): 'providers' | 'imaging' | 'bills' | 'correspondence' {
  if (fieldName.includes('provider') || fieldName.includes('treatmentRecap')) {
    return 'providers';
  }
  if (fieldName.includes('imaging')) {
    return 'imaging';
  }
  if (fieldName.includes('bill') || fieldName.includes('medical')) {
    return 'bills';
  }
  return 'correspondence';
}

/**
 * Get field-specific extraction instructions
 */
function getFieldInstructions(field: FieldDefinition): string {
  const instructions: Record<string, string> = {
    'treatmentRecap.providerDetails': `
CRITICAL: Extract EVERY SINGLE provider mentioned in the document.
Include:
- Hospitals (including emergency departments)
- Medical clinics
- Individual doctors (by name)
- Chiropractors
- Physical therapists
- Radiology centers
- Ambulance/transport services
- Pharmacies

For EACH provider, extract:
1. Full name (e.g., "Tampa General Hospital", "Chambers Medical Group - Dr. Smith")
2. Specialty (Emergency, Chiropractic, Physical Therapy, Physician, Radiology, etc.)
3. Date range (e.g., "06/27/2025" or "07/01/2025 - 08/15/2025")
4. Total visits (count them, e.g., "1", "12", "19")
5. Treatments provided with CPT codes if available (e.g., ["Ultrasound (CPT 97035)", "Electric Stim (CPT 97014)"])
6. Page references (e.g., "p. 5", "pp. 10-20")`,

    'treatmentRecap.imagingResults': `
CRITICAL: Extract EVERY imaging study with COMPLETE findings.
Include:
- CT scans
- MRI scans
- X-rays
- Ultrasounds
- Other diagnostic imaging

For EACH imaging study, extract:
1. Type (e.g., "CT Cervical Spine", "MRI Lumbar", "X-ray Shoulder")
2. Body part examined
3. Date performed
4. COMPLETE findings/impressions (copy verbatim from radiology report, do not summarize)
5. Page reference`,

    'treatmentRecap.prognosisAssessment': `
Extract prognosis and future treatment information if documented.
Include:
1. Prognosis description (permanent injury, recovery timeline)
2. Impairment rating (e.g., "12% whole person impairment")
3. Future expenses (e.g., "$2,000 annually")
4. Page reference`,

    'treatmentRecap.totalVisits': `
Count the TOTAL number of visits across ALL providers.
Include:
- Emergency room visits
- Urgent care visits
- Physician office visits
- Chiropractic visits
- Physical therapy sessions
- Specialist consultations

Return only the total number as a string (e.g., "24").`,

    'diagnosedInjuries': `
Extract ALL diagnosed injuries from medical records.
For each injury, include:
1. Injury description with body part
2. Whether scarring was noted (true/false)
3. Page reference`,

    'medicalBillBreakdown': `
Extract ALL billing records.
For each bill, include:
1. Date of service
2. Provider name
3. Complaints or diagnosis
4. Type of service
5. Amount billed
6. Health insurance paid (if documented)
7. Page reference`
  };

  return instructions[field.name] || 'Extract this field accurately from the document.';
}

/**
 * Get extraction directive for a field
 */
function getExtractionDirective(field: FieldDefinition): string {
  if (field.type === 'array') {
    return `Be thorough - do not miss any items. Create one array entry for each item found.`;
  }
  if (field.type === 'object') {
    return `Extract all available subfields. Leave fields empty if not documented.`;
  }
  return `Extract this value accurately. Return null if not found in the document.`;
}

/**
 * Call Gemini via Vertex AI to extract a specific field.
 * Same service account auth used by analyze-claim-document Pass 1.
 */
async function callAIForField(
  field: FieldDefinition,
  prompt: string,
  _extractedText: ExtractedTextStructure
): Promise<any> {
  try {
    const token = await getAccessToken();
    const projectId = getProjectId();
    const region = getRegion();
    const model = 'gemini-2.5-flash';

    const response = await fetch(
      `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          // T=0 — gap-fill is structured field extraction; determinism wins.
          generationConfig: { temperature: 0, maxOutputTokens: 8192 },
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      log('ERROR', 'GAP_FILL', `Vertex AI error: ${response.status} - ${errorText.substring(0, 200)}`);
      return null;
    }

    const result = await response.json();
    const content = result.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!content) {
      log('WARN', 'GAP_FILL', `Empty response from Vertex AI (finishReason=${result.candidates?.[0]?.finishReason ?? 'unknown'})`);
      return null;
    }

    return parseFieldResponse(content, field);

  } catch (error) {
    log('ERROR', 'GAP_FILL', `API call failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Parse AI response for a specific field
 */
function parseFieldResponse(content: string, field: FieldDefinition): any {
  try {
    // Strip markdown code blocks if present
    let cleaned = content.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.substring(7);
    }
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.substring(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.substring(0, cleaned.length - 3);
    }
    cleaned = cleaned.trim();

    // Remove comments (defense in depth)
    cleaned = cleaned
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '');

    // Parse JSON
    const parsed = JSON.parse(cleaned);

    // Extract field value.
    // Use `in` (presence check) rather than `||` so falsy-but-present values
    // (null, 0, '', false) are returned as-is. The previous `|| parsed`
    // returned the entire wrapper object when gap-fill legitimately found
    // nothing and returned `{ "<field.name>": null }` — that's what produced
    // the `{"treatmentRecap.narrative": null}` corruption affecting ~1162
    // prod rows from the 2026-06-01/02 ingestion days.
    const value = field.name in parsed ? parsed[field.name] : parsed;

    log('DEBUG', 'GAP_FILL', `Parsed ${field.name}: ${JSON.stringify(value).substring(0, 200)}`);

    return value;

  } catch (error) {
    log('ERROR', 'GAP_FILL', `Failed to parse response for ${field.name}: ${error instanceof Error ? error.message : String(error)}`);
    log('DEBUG', 'GAP_FILL', `Raw content: ${content.substring(0, 500)}`);
    return null;
  }
}

/**
 * Merge gap-fill results into initial analysis
 * Only fills empty fields, doesn't overwrite existing data
 */
function mergeGapFillResults(
  initialAnalysis: any,
  gapFillResults: Record<string, any>
): any {
  const merged = { ...initialAnalysis };

  for (const [fieldName, value] of Object.entries(gapFillResults)) {
    if (value !== null && value !== undefined) {
      const currentValue = getNestedValue(merged, fieldName);

      // Only fill if current value is empty
      if (!currentValue ||
          (Array.isArray(currentValue) && currentValue.length === 0) ||
          (typeof currentValue === 'string' && currentValue.trim() === '') ||
          (typeof currentValue === 'object' && Object.keys(currentValue).length === 0)) {

        setNestedValue(merged, fieldName, value);
        log('INFO', 'GAP_FILL', `Merged ${fieldName} from Pass 2`);
      } else {
        log('DEBUG', 'GAP_FILL', `Skipped ${fieldName} - already has value from Pass 1`);
      }
    }
  }

  return merged;
}

/**
 * Overwrite-mode merge used by the Pass 5 grounding repair loop.
 * The evaluator may flag a field that's *populated but wrong* — we must
 * replace it, not skip it like the empty-only merge does.
 */
function overwriteGapFillResults(
  initialAnalysis: any,
  gapFillResults: Record<string, any>,
): any {
  const merged = { ...initialAnalysis };
  for (const [fieldName, value] of Object.entries(gapFillResults)) {
    if (value !== null && value !== undefined) {
      setNestedValue(merged, fieldName, value);
      log('INFO', 'GAP_FILL', `Overwrote ${fieldName} per grounding repair`);
    }
  }
  return merged;
}
