// Field Schema Registry for Multi-Pass Extraction Pipeline
// Defines what fields to extract, where to find them, and how to validate them.
//
// Phase 1 (2026-06-09): `required` was a bare boolean. Now it's joined by an
// optional `requiredForTypes` that scopes "required" to specific document types
// (matching the Pass 0 classifier output in `claim_documents.document_classifications`).
// When `requiredForTypes` is set, it OVERRIDES the bare `required` flag and means
// "required only if the document's classifications include one of these types."
// When omitted, `required` keeps its original always-on semantics.
//
// Type vocabulary lives in DOCUMENT_TYPE_VOCAB below — keep this in sync with
// _shared/prompts.ts:DOCUMENT_RECOGNITION_PATTERNS.

export type DocumentTypeName =
  | 'correspondence'
  | 'fnol'
  | 'declarations_page'
  | 'demand_letter'
  | 'hospital_facesheet'
  | 'er_record'
  | 'physician_notes'
  | 'operative_report'
  | 'radiology_report'
  | 'physical_therapy'
  | 'medical_signin_slip'
  | 'medical_record'        // catch-all medical type when not a more specific subtype
  | 'bills'
  | 'police_report'
  | 'pharmacy_records'
  | 'other';

export const DOCUMENT_TYPE_VOCAB: readonly DocumentTypeName[] = [
  'correspondence', 'fnol', 'declarations_page', 'demand_letter',
  'hospital_facesheet', 'er_record', 'physician_notes', 'operative_report',
  'radiology_report', 'physical_therapy', 'medical_signin_slip', 'medical_record',
  'bills', 'police_report', 'pharmacy_records', 'other',
] as const;

/**
 * Pass 0 classifier output. Stored on `claim_documents.document_classifications`.
 * A document can span multiple types via page-range entries (e.g. a 200-page
 * bundle: correspondence pp.1-19, medical pp.20-45, bills pp.46-60).
 */
export interface DocumentClassification {
  type: DocumentTypeName;
  pageStart: number;
  pageEnd: number;
  confidence: number; // 0-1
}

export interface FieldDefinition {
  name: string;
  type: 'string' | 'array' | 'object' | 'boolean' | 'number';
  /** Always-on required flag. Ignored when `requiredForTypes` is set. */
  required: boolean;
  /** When set, "required" means "required only if doc classifications include one of these types". */
  requiredForTypes?: DocumentTypeName[];
  minConfidence: number; // Minimum acceptable confidence (0.0-1.0)
  extractionHints: string[]; // Where to look for this field
  validationRules?: {
    format?: RegExp; // Format validation (e.g., claim number pattern)
    minLength?: number; // For arrays/strings
    mustContain?: string[]; // Required substrings
  };
  dependencies?: string[]; // Fields that share same data
  aggregationLogic?: string; // For computed fields (e.g., "sum of provider.visits")
}

/**
 * Resolve whether a field is required for a specific document's classifications.
 * If the field has no `requiredForTypes`, fall back to the bare `required` flag.
 * Otherwise, required iff ANY of the doc's classified types is in `requiredForTypes`.
 * Pre-Pass-0 docs (classifications=null/empty) fall through to the bare `required`
 * so existing behaviour is preserved.
 */
export function isFieldRequiredFor(
  field: FieldDefinition,
  classifications: DocumentClassification[] | null | undefined,
): boolean {
  if (!field.requiredForTypes || field.requiredForTypes.length === 0) {
    return field.required;
  }
  if (!classifications || classifications.length === 0) {
    return field.required; // pre-classification fallback
  }
  const docTypes = new Set(classifications.map(c => c.type));
  return field.requiredForTypes.some(t => docTypes.has(t));
}

const MEDICAL_TYPES: readonly DocumentTypeName[] = [
  'medical_record', 'physician_notes', 'er_record', 'physical_therapy',
  'operative_report', 'radiology_report', 'medical_signin_slip', 'hospital_facesheet',
];

const CLAIM_METADATA_TYPES: readonly DocumentTypeName[] = [
  'fnol', 'declarations_page', 'demand_letter', 'correspondence', 'police_report',
];

// Complete extraction schema for all claim document fields
export const EXTRACTION_SCHEMA: Record<string, FieldDefinition> = {
  'extractedClaimNumber': {
    name: 'extractedClaimNumber',
    type: 'string',
    required: true,
    requiredForTypes: [...CLAIM_METADATA_TYPES, 'bills'],
    minConfidence: 0.8,
    extractionHints: ['First page header', 'Correspondence letterhead', 'Claim form top section'],
    validationRules: { format: /^[A-Z0-9-]{5,25}$/ },
    dependencies: ['headerInfo.claimNumber']
  },

  'treatmentRecap.providerDetails': {
    name: 'treatmentRecap.providerDetails',
    type: 'array',
    required: true,
    requiredForTypes: [...MEDICAL_TYPES],
    minConfidence: 0.7,
    extractionHints: [
      'Medical records showing provider names',
      'Treatment chronology sections',
      'Bill headers with provider information',
      'Visit summaries and appointments',
      'Emergency room records',
      'Chiropractic visit notes',
      'Physician consultation notes'
    ],
    validationRules: { minLength: 1 } // Must have at least one provider
  },

  'treatmentRecap.imagingResults': {
    name: 'treatmentRecap.imagingResults',
    type: 'array',
    required: false, // Not all claims have imaging
    minConfidence: 0.8,
    extractionHints: [
      'Radiology reports',
      'Imaging study results',
      'CT/MRI/X-ray findings sections',
      'Diagnostic imaging impressions',
      'Ultrasound results'
    ]
  },

  'treatmentRecap.prognosisAssessment': {
    name: 'treatmentRecap.prognosisAssessment',
    type: 'object',
    required: false, // Not all claims have prognosis
    minConfidence: 0.7,
    extractionHints: [
      'Prognosis sections in medical reports',
      'IME reports with impairment ratings',
      'Physician assessment of permanent injury',
      'Future treatment recommendations',
      'Functional capacity evaluations'
    ]
  },

  'treatmentRecap.totalVisits': {
    name: 'treatmentRecap.totalVisits',
    type: 'string',
    required: true,
    requiredForTypes: [...MEDICAL_TYPES],
    minConfidence: 0.9,
    aggregationLogic: 'sum(treatmentRecap.providerDetails[].visits)', // Calculated field
    extractionHints: ['Calculate from ALL providers including ER, urgent care, specialists, chiropractic, physical therapy']
  },

  'treatmentRecap.narrative': {
    name: 'treatmentRecap.narrative',
    type: 'string',
    required: true,
    requiredForTypes: [...MEDICAL_TYPES],
    minConfidence: 0.8,
    extractionHints: [
      'Medical records overview',
      'Treatment summary sections',
      'Chronological treatment history'
    ],
    validationRules: { minLength: 50 }
  },

  'diagnosedInjuries': {
    name: 'diagnosedInjuries',
    type: 'array',
    required: true,
    requiredForTypes: [...MEDICAL_TYPES, 'demand_letter'],
    minConfidence: 0.7,
    extractionHints: [
      'Diagnostic sections in medical records',
      'ICD-10 codes',
      'Injury descriptions',
      'Emergency room diagnosis',
      'Follow-up visit diagnoses'
    ],
    validationRules: { minLength: 1 }
  },

  'medicalBillBreakdown': {
    name: 'medicalBillBreakdown',
    type: 'array',
    required: false, // Not all documents have bills
    minConfidence: 0.8,
    extractionHints: [
      'Billing statements',
      'Itemized bills',
      'CPT codes and charges',
      'Insurance EOB statements',
      'Provider invoices'
    ]
  },

  'incidentDate': {
    name: 'incidentDate',
    type: 'string',
    required: true,
    requiredForTypes: [...CLAIM_METADATA_TYPES],
    minConfidence: 0.9,
    extractionHints: [
      'Date of loss/accident',
      'First page incident date',
      'Emergency room visit date (often matches incident)',
      'Claim form date of injury'
    ],
    validationRules: { format: /^\d{4}-\d{2}-\d{2}$/ } // ISO date format
  },

  'incidentLocation': {
    name: 'incidentLocation',
    type: 'string',
    required: true,
    requiredForTypes: ['fnol', 'police_report', 'declarations_page'],
    minConfidence: 0.7,
    extractionHints: [
      'Location field on claim forms',
      'Police report location',
      'Scene of accident description',
      'Incident narrative address'
    ]
  },

  'impactToLife': {
    name: 'impactToLife',
    type: 'string',
    required: false,
    minConfidence: 0.6,
    extractionHints: [
      'Patient statements about daily activities',
      'Functional limitations described',
      'Work restrictions',
      'Pain and suffering descriptions',
      'Quality of life impacts'
    ]
  },

  'claimedWageLoss': {
    name: 'claimedWageLoss',
    type: 'string',
    required: false,
    minConfidence: 0.7,
    extractionHints: [
      'Wage loss documentation',
      'Employer statements',
      'Lost income calculations',
      'Time off work records'
    ]
  },

  'priorInjuries': {
    name: 'priorInjuries',
    type: 'string',
    required: false,
    minConfidence: 0.7,
    extractionHints: [
      'Medical history sections',
      'Pre-existing conditions',
      'Past injury mentions',
      'Prior accident references'
    ]
  },

  // -----------------------------------------------------------------------
  // PR #88 adjuster-portion source fields (added 2026-06-11). These are
  // requested by the per-doc Gemini prompt in _shared/prompts.ts and lifted
  // into ai_synthesis.adjusterPortion by review-claim-synthesis. Until they
  // landed in EXTRACTION_SCHEMA they were ALSO missing from
  // buildResponseSchema() — Gemini stripped them from structured output and
  // they never made it to ai_analysis. See
  // docs/2026-06-10-ImageRight-Attribute-Discovery.md for the diagnostic
  // trail.
  //
  // `requiredForTypes` is scoped narrowly so we don't ding e.g. a medical
  // record for missing facts_of_loss (which only FNOL / police_report etc.
  // can supply).
  // -----------------------------------------------------------------------

  'facts_of_loss': {
    name: 'facts_of_loss',
    type: 'string',
    required: false,
    requiredForTypes: ['fnol', 'police_report', 'demand_letter', 'correspondence'],
    minConfidence: 0.7,
    extractionHints: [
      'FNOL "Loss Description" / "Statement of Loss" narrative',
      'Police report incident narrative',
      'Demand letter "Facts" section',
      'Correspondence describing the incident',
    ],
    validationRules: { minLength: 20 },
  },

  'policy_limits': {
    name: 'policy_limits',
    type: 'string',
    required: false,
    requiredForTypes: ['declarations_page', 'fnol'],
    minConfidence: 0.8,
    extractionHints: [
      'Declarations page coverage limits table',
      'BI per-person / per-occurrence numeric values',
      'FNOL "Coverage Information" block (e.g. "BI 100/300")',
      'UM/UIM, Med-Pay, PIP limits if listed',
    ],
  },

  'liability_signals': {
    name: 'liability_signals',
    type: 'object',
    required: false,
    requiredForTypes: ['fnol', 'police_report', 'demand_letter', 'correspondence'],
    minConfidence: 0.7,
    extractionHints: [
      'FNOL "Is liability clear?" field',
      'Police report fault assignment',
      'Demand letter liability assertion',
      'Correspondence with explicit fault language',
    ],
  },

  'impact_severity_signals': {
    name: 'impact_severity_signals',
    type: 'object',
    required: false,
    requiredForTypes: [...MEDICAL_TYPES, 'fnol', 'police_report'],
    minConfidence: 0.7,
    extractionHints: [
      'MVA severity descriptors (light / moderate / heavy collision)',
      'Vehicle totaled / drivable',
      'Ambulance transport, loss of consciousness, airbag deployment',
      'MRI findings severity language',
    ],
  },

  'treatment_intensity_signals': {
    name: 'treatment_intensity_signals',
    type: 'object',
    required: false,
    requiredForTypes: [...MEDICAL_TYPES, 'demand_letter'],
    minConfidence: 0.7,
    extractionHints: [
      'Visit count + treatment span across providers',
      'Surgery performed / injection count / imaging count',
      'MMI status, specialist referral',
    ],
  },

  'provider_visit_details': {
    name: 'provider_visit_details',
    type: 'array',
    required: false,
    requiredForTypes: [...MEDICAL_TYPES],
    minConfidence: 0.7,
    extractionHints: [
      'Per-visit medical record entries',
      'Chief complaint / exam findings / impressions / plan, verbatim',
      'Page references to the source visit',
    ],
    validationRules: { minLength: 1 },
  },

  'billsSummary': {
    name: 'billsSummary',
    type: 'object',
    required: false,
    requiredForTypes: ['bills'],
    minConfidence: 0.7,
    extractionHints: [
      'Total billed across providers',
      'Total attorney-claimed amount (if a demand is being prepared)',
      'Insurance offsets noted (PIP / Med-Pay / WC)',
    ],
  },

  // -----------------------------------------------------------------------
  // Claim-header legal fields (added 2026-06-15). Scoped to the doc types that
  // actually carry them so a misclassified/medical doc isn't dinged, but a
  // demand letter that came back without them gets a gap-fill retry. (DOB /
  // gender are intentionally NOT here — they're claim-level, found once across
  // any doc; forcing a per-doc retry on every medical record would be wasteful.
  // The responseSchema headerInfo block + prompt + synthesis aggregation cover
  // them.)
  // -----------------------------------------------------------------------
  'headerInfo.attorneyRepresented': {
    name: 'headerInfo.attorneyRepresented',
    type: 'string',
    required: false,
    requiredForTypes: ['demand_letter', 'correspondence'],
    minConfidence: 0.7,
    extractionHints: [
      'Law-firm letterhead at the top of a demand/representation letter',
      'Attorney signature block (firm name)',
      'Emit "Yes - <Firm Name>" when represented, else "No"',
    ],
  },

  'headerInfo.timeLimitDemand': {
    name: 'headerInfo.timeLimitDemand',
    type: 'string',
    required: false,
    // A time-limit demand can arrive as a formal demand letter OR as attorney
    // correspondence (common on PIP/UIM claims with no separate demand_letter).
    requiredForTypes: ['demand_letter', 'correspondence'],
    minConfidence: 0.7,
    extractionHints: [
      'A CLAIMANT/attorney response or settlement deadline ("please respond by <date>", "offer expires <date>", "tender policy limits within 30 days")',
      'Appears in a demand letter OR attorney correspondence DEMANDING settlement from the insurer',
      'NOT an insurer-originated deadline: an IME-cancellation notice, a records-request "respond within 30 days" HIPAA notice, or a reservation-of-rights letter is NOT a time-limit demand',
    ],
  },

  'headerInfo.demandAmount': {
    name: 'headerInfo.demandAmount',
    type: 'string',
    required: false,
    // Same sourcing as timeLimitDemand: a demanded settlement sum can appear in a
    // formal demand letter OR in attorney correspondence.
    requiredForTypes: ['demand_letter', 'correspondence'],
    minConfidence: 0.7,
    extractionHints: [
      'The CLAIMANT/attorney demanded settlement sum ("we demand $100,000", "policy-limits demand", "$X to resolve")',
      'Appears in a demand letter OR attorney correspondence demanding settlement from the insurer',
      'NOT an internal reserve, NOT PIP/Med-Pay amounts paid, NOT a medical-bill total, NOT a coverage/policy limit unless the claimant explicitly DEMANDS that amount',
      'Emit a human-formatted value (e.g. "$100,000" or "policy limits"); null if no genuine claimant demand is present',
    ],
  },

  'postAccidentRecap': {
    name: 'postAccidentRecap',
    type: 'array',
    required: false,
    requiredForTypes: [...MEDICAL_TYPES],
    minConfidence: 0.7,
    extractionHints: [
      'Per-provider recap of visits dated AFTER the accident',
      'Provider + summary (with CPT codes when present) + page refs',
    ],
    validationRules: { minLength: 1 },
  },
};

// Helper function to get required fields only.
// Pre-Phase-1 callers pass no classifications → falls back to bare `required` flag.
// Phase-1 callers pass the doc's classifications → fields scoped via `requiredForTypes`
// are filtered to only those that apply to the doc's classified types.
export function getRequiredFields(
  classifications?: DocumentClassification[] | null,
): FieldDefinition[] {
  return Object.values(EXTRACTION_SCHEMA).filter(f => isFieldRequiredFor(f, classifications));
}

// Helper function to identify fields that need retry (missing or empty).
// When `classifications` is provided, only fields actually required for this
// doc's types are considered candidates for retry — avoids the old "ask for
// treatment narrative on a status email" behaviour.
export function getFieldsForRetry(
  currentData: any,
  classifications?: DocumentClassification[] | null,
): FieldDefinition[] {
  return Object.values(EXTRACTION_SCHEMA).filter(field => {
    const value = getNestedValue(currentData, field.name);

    // Empty/missing checks — same rules as before
    let isEmpty = false;
    if (!value) {
      isEmpty = true;
    } else if (field.type === 'array' && Array.isArray(value) && value.length === 0) {
      isEmpty = true;
    } else if (field.type === 'string' && typeof value === 'string' && value.trim() === '') {
      isEmpty = true;
    } else if (field.type === 'object' && typeof value === 'object' && Object.keys(value).length === 0) {
      isEmpty = true;
    }

    if (!isEmpty) return false;

    // Empty fields only get retried if they're actually required for THIS doc.
    // Optional / type-mismatched fields stay empty without triggering a retry.
    return isFieldRequiredFor(field, classifications);
  });
}

// Helper function to get nested object values (e.g., "treatmentRecap.providerDetails")
export function getNestedValue(obj: any, path: string): any {
  if (!obj || !path) return undefined;

  const keys = path.split('.');
  let current = obj;

  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }

  return current;
}

// Helper function to set nested object values
export function setNestedValue(obj: any, path: string, value: any): void {
  if (!obj || !path) return;

  const keys = path.split('.');
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }

  current[keys[keys.length - 1]] = value;
}

// Helper function to check if a value is considered empty
export function isEmptyValue(value: any): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === 'object' && Object.keys(value).length === 0) return true;
  return false;
}

// Get field definition by name
export function getFieldDefinition(fieldName: string): FieldDefinition | undefined {
  return EXTRACTION_SCHEMA[fieldName];
}

// Check if field is required (no classifications: falls back to bare `required`).
export function isRequiredField(
  fieldName: string,
  classifications?: DocumentClassification[] | null,
): boolean {
  const field = getFieldDefinition(fieldName);
  if (!field) return false;
  return isFieldRequiredFor(field, classifications);
}

// Get all field names
export function getAllFieldNames(): string[] {
  return Object.keys(EXTRACTION_SCHEMA);
}

// Render the schema as a grading rubric the Anthropic grounding evaluator can
// reference per-field. Lives here (not in the Anthropic util) so schema and
// rubric stay in sync — adding a field to EXTRACTION_SCHEMA automatically
// updates what the evaluator grades.
//
// When `classifications` is provided, the rubric marks fields as REQUIRED only
// when they're actually required for this doc's types. Optional / out-of-scope
// fields appear as 'optional' so Claude doesn't ding the doc for missing them.
export function buildGroundingRubric(
  classifications?: DocumentClassification[] | null,
): string {
  const lines: string[] = [];
  for (const def of Object.values(EXTRACTION_SCHEMA)) {
    const required = isFieldRequiredFor(def, classifications) ? 'REQUIRED' : 'optional';
    const minConf = `min_confidence=${def.minConfidence}`;
    const rules: string[] = [];
    if (def.validationRules?.format) rules.push(`format=${def.validationRules.format}`);
    if (def.validationRules?.minLength) rules.push(`min_length=${def.validationRules.minLength}`);
    const rulesStr = rules.length ? ` | ${rules.join(', ')}` : '';
    const hints = def.extractionHints.slice(0, 4).join('; ');
    lines.push(`- ${def.name} (${def.type}, ${required}, ${minConf}${rulesStr}): look for ${hints}.`);
  }
  return lines.join('\n');
}

/**
 * Build a Gemini-compatible OpenAPI-3.0 responseSchema for the extraction
 * pipeline. The schema is the same shape regardless of classifications — every
 * field is permitted; classifications only affect the `required` array
 * (which Gemini enforces structurally).
 *
 * Top-level shape matches what the existing prompts ask for. Nested objects
 * are inlined as needed. Field names that contain dots (e.g.
 * `treatmentRecap.narrative`) get flattened to nested object structures here
 * so the schema is JSON-valid (Gemini does not support dotted keys).
 *
 * NOTE: this is intentionally permissive on optional fields (no narrow `enum`
 * constraints, no min/max bounds) so the model has room to phrase content
 * naturally. The grounding pass and validation pass catch quality issues
 * downstream; responseSchema's job is ONLY to enforce JSON well-formedness.
 */
export function buildResponseSchema(
  classifications?: DocumentClassification[] | null,
): Record<string, unknown> {
  const requiredTopLevel: string[] = [];
  const properties: Record<string, unknown> = {
    extractedClaimNumber: { type: 'string', nullable: true },
    incidentDate: { type: 'string', nullable: true },
    incidentLocation: { type: 'string', nullable: true },
    diagnosedInjuries: { type: 'array', items: { type: 'string' }, nullable: true },
    impactToLife: { type: 'string', nullable: true },
    claimedWageLoss: { type: 'string', nullable: true },
    priorInjuries: { type: 'string', nullable: true },

    // --- Claim identity + header fields (added 2026-06-15) ---
    // These are requested by the per-doc prompt (_shared/prompts.ts) but were
    // ABSENT from this responseSchema, so Gemini structured output STRIPPED them
    // from ai_analysis — the exact bug the PR #88 adjuster fields hit. Without
    // them, DOB / gender / attorney / time-limit / namedobGender never reach
    // synthesis, so the claim card shows "DOB unknown / Firm not specified".
    // Permissive shapes (no enums) — quality is enforced by the prompt + synthesis.
    extractedClaimantName: { type: 'string', nullable: true },
    extractedDateOfBirth:  { type: 'string', nullable: true },
    extractedGender:       { type: 'string', nullable: true },
    extractedClaimType:    { type: 'string', nullable: true },
    extractedIdentifiers: {
      type: 'object', nullable: true,
      properties: {
        claimNumber:  { type: 'object', nullable: true, properties: { value: { type: 'string', nullable: true }, source: { type: 'string', nullable: true }, pageRef: { type: 'string', nullable: true }, confidence: { type: 'number', nullable: true } } },
        claimantName: { type: 'object', nullable: true, properties: { value: { type: 'string', nullable: true }, variations: { type: 'array', items: { type: 'string' }, nullable: true }, source: { type: 'string', nullable: true }, pageRef: { type: 'string', nullable: true }, confidence: { type: 'number', nullable: true } } },
        dateOfBirth:  { type: 'object', nullable: true, properties: { value: { type: 'string', nullable: true }, source: { type: 'string', nullable: true }, pageRef: { type: 'string', nullable: true }, confidence: { type: 'number', nullable: true } } },
        gender:       { type: 'object', nullable: true, properties: { value: { type: 'string', nullable: true }, source: { type: 'string', nullable: true }, pageRef: { type: 'string', nullable: true }, confidence: { type: 'number', nullable: true } } },
        dateOfLoss:   { type: 'object', nullable: true, properties: { value: { type: 'string', nullable: true }, source: { type: 'string', nullable: true }, pageRef: { type: 'string', nullable: true }, confidence: { type: 'number', nullable: true } } },
      },
    },
    headerInfo: {
      type: 'object', nullable: true,
      properties: {
        claimNumber:         { type: 'string', nullable: true },
        dateCompleted:       { type: 'string', nullable: true },
        completedBy:         { type: 'string', nullable: true },
        claimantFullName:    { type: 'string', nullable: true },
        dateOfBirth:         { type: 'string', nullable: true },
        gender:              { type: 'string', nullable: true },
        namedobGender:       { type: 'string', nullable: true },
        seatbelt:            { type: 'string', nullable: true },
        accidentLocation:    { type: 'string', nullable: true },
        dateOfAccident:      { type: 'string', nullable: true },
        accidentType:        { type: 'string', nullable: true },
        attorneyRepresented: { type: 'string', nullable: true },
        timeLimitDemand:     { type: 'string', nullable: true },
        demandAmount:        { type: 'string', nullable: true },
        confidence:          { type: 'number', nullable: true },
      },
    },
    postAccidentRecap: {
      type: 'array', nullable: true,
      items: { type: 'object', properties: {
        provider: { type: 'string', nullable: true },
        summary:  { type: 'string', nullable: true },
        cptCodes: { type: 'array', items: { type: 'string' }, nullable: true },
        pageRefs: { type: 'string', nullable: true },
      } },
    },
    preAccidentRecap: {
      type: 'array', nullable: true,
      items: { type: 'object', properties: {
        provider: { type: 'string', nullable: true },
        summary:  { type: 'string', nullable: true },
        cptCodes: { type: 'array', items: { type: 'string' }, nullable: true },
        pageRefs: { type: 'string', nullable: true },
      } },
    },

    treatmentRecap: {
      type: 'object',
      nullable: true,
      properties: {
        providerDetails: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              providerName: { type: 'string', nullable: true },
              specialty:    { type: 'string', nullable: true },
              visits:       { type: 'string', nullable: true },
              dateRange:    { type: 'string', nullable: true },
            },
          },
          nullable: true,
        },
        imagingResults: { type: 'array', items: { type: 'string' }, nullable: true },
        prognosisAssessment: {
          type: 'object',
          nullable: true,
          properties: {
            summary:           { type: 'string', nullable: true },
            permanentImpairment: { type: 'string', nullable: true },
            futureCare:        { type: 'string', nullable: true },
          },
        },
        totalVisits: { type: 'string', nullable: true },
        narrative:   { type: 'string', nullable: true },
      },
    },
    medicalBillBreakdown: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          provider:                 { type: 'string', nullable: true },
          amount:                   { type: 'string', nullable: true },
          dateRange:                { type: 'string', nullable: true },
          // PR #88 enrichment
          lien_holder:              { type: 'string', nullable: true },
          paid_by_insurance_amount: { type: 'string', nullable: true },
        },
      },
      nullable: true,
    },
    // --- PR #88 adjuster-portion source fields ---
    facts_of_loss: { type: 'string', nullable: true },
    policy_limits: { type: 'string', nullable: true },
    liability_signals: {
      type: 'object',
      nullable: true,
      properties: {
        at_fault_party:          { type: 'string', nullable: true },
        traffic_violation_cited: { type: 'string', nullable: true },
        fault_admission_quoted:  { type: 'string', nullable: true },
        is_liability_clear:      { type: 'string', nullable: true },
        contributing_factors:    { type: 'array', items: { type: 'string' }, nullable: true },
        evidence_sources:        { type: 'array', items: { type: 'string' }, nullable: true },
      },
    },
    impact_severity_signals: {
      type: 'object',
      nullable: true,
      properties: {
        mva_severity:                       { type: 'string',  nullable: true },
        totaled_vehicle:                    { type: 'boolean', nullable: true },
        ambulance_transport:                { type: 'boolean', nullable: true },
        loss_of_consciousness:              { type: 'boolean', nullable: true },
        airbag_deployed:                    { type: 'boolean', nullable: true },
        prior_visits_count_before_incident: { type: 'number',  nullable: true },
        mri_findings_severity:              { type: 'string',  nullable: true },
      },
    },
    treatment_intensity_signals: {
      type: 'object',
      nullable: true,
      properties: {
        visit_count:           { type: 'number',  nullable: true },
        treatment_span_months: { type: 'number',  nullable: true },
        surgery_performed:     { type: 'boolean', nullable: true },
        injections_received:   { type: 'boolean', nullable: true },
        injection_count:       { type: 'number',  nullable: true },
        imaging_count:         { type: 'number',  nullable: true },
        mmi_reached:           { type: 'boolean', nullable: true },
        referral_to_specialist:{ type: 'string',  nullable: true },
      },
    },
    provider_visit_details: {
      type: 'array',
      nullable: true,
      items: {
        type: 'object',
        properties: {
          date:                 { type: 'string', nullable: true },
          provider:             { type: 'string', nullable: true },
          chief_complaint:      { type: 'string', nullable: true },
          exam_findings_quoted: { type: 'string', nullable: true },
          impressions_quoted:   { type: 'string', nullable: true },
          plan_quoted:          { type: 'string', nullable: true },
          page_ref:             { type: 'string', nullable: true },
        },
      },
    },
    billsSummary: {
      type: 'object',
      nullable: true,
      properties: {
        total_billed:            { type: 'string', nullable: true },
        total_atty_claimed:      { type: 'string', nullable: true },
        insurance_offsets_noted: { type: 'string', nullable: true },
      },
    },
  };

  // Top-level required-array: any field whose flat name is required for this
  // doc's classifications, mapped back to its top-level container.
  const topLevelOf = (flatName: string) => flatName.split('.')[0];
  for (const def of Object.values(EXTRACTION_SCHEMA)) {
    if (!isFieldRequiredFor(def, classifications)) continue;
    const top = topLevelOf(def.name);
    if (!requiredTopLevel.includes(top)) requiredTopLevel.push(top);
  }

  return {
    type: 'object',
    properties,
    required: requiredTopLevel,
  };
}
