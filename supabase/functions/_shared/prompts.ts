// AI prompt building for document analysis with semantic document understanding

import { ClaimDetails } from './types.ts';
import { DocumentClassification } from './extraction-schema.ts';
import { log } from './utils.ts';

/**
 * Render the Pass 0 classifier result as a focused page-range hint block for
 * Pass 1's user prompt. Gemini doesn't *enforce* page restrictions, but
 * highlighting "medical content lives on pages 20-45" materially shifts where
 * the model looks. Without this, the model may miss content in 100+ page
 * bundles or hallucinate medical fields from correspondence pages.
 *
 * Empty result (no classifications, or only `other`) returns an empty string
 * so the prompt is unchanged for unclassified docs.
 */
export function buildClassificationsHint(
  classifications: DocumentClassification[] | null | undefined,
): string {
  if (!classifications || classifications.length === 0) return '';
  const meaningful = classifications.filter(c => c.type !== 'other');
  if (meaningful.length === 0) return '';

  const lines = classifications.map(c =>
    `  - Pages ${c.pageStart}-${c.pageEnd}: ${c.type} (confidence ${c.confidence.toFixed(2)})`,
  );

  return `\nDOCUMENT STRUCTURE (Pass 0 classifier output — use this to focus extraction on the right page ranges):
${lines.join('\n')}

IMPORTANT: When a field's data should come from a specific section, look in the corresponding page range — and do NOT fabricate content from OTHER sections. Examples:
  - Medical fields (treatmentRecap.*, diagnosedInjuries) should come from medical_record / physician_notes / er_record / operative_report / radiology_report / physical_therapy ranges only.
  - Demand totals come from demand_letter ranges.
  - Incident details come from fnol / declarations_page / police_report / demand_letter ranges.
  - If the document has no range of the relevant type, return NULL for that field — do NOT make it up.\n`;
}

// Document type classification patterns
const DOCUMENT_RECOGNITION_PATTERNS = `
DOCUMENT RECOGNITION PATTERNS:

LEGAL DEMAND LETTERS typically contain:
- Law firm letterhead with attorney names
- "RE:" block with client name, claim number, date of loss
- Formal demand language ("demand is hereby made...")
- Settlement amount requested
- Time limit for response

HOSPITAL FACESHEETS typically contain:
- Hospital logo/name at top
- "Patient Demographics" or "Registration" section
- Fields: Name, DOB, SSN (last 4), Gender, Address
- Admission/Discharge dates
- MRN (Medical Record Number)
- Insurance information

EMERGENCY ROOM RECORDS typically contain:
- Triage notes and vital signs
- Chief complaint
- Emergency physician notes
- Disposition (admitted, discharged)

PHYSICIAN NOTES typically contain:
- Provider name and specialty
- Date of service
- Chief Complaint / History of Present Illness
- Physical Examination findings
- Assessment and Plan
- Signature line

OPERATIVE REPORTS typically contain:
- Pre-operative and post-operative diagnoses
- Procedure performed
- Surgeon and assistant names
- Anesthesia type
- Findings and technique narrative

RADIOLOGY REPORTS typically contain:
- Imaging type (X-ray, MRI, CT, Ultrasound)
- Body part examined
- Technique/protocol
- Findings
- Impression/conclusion

PHYSICAL THERAPY NOTES typically contain:
- Treatment goals
- Exercises performed
- Progress notes
- Pain levels
- Range of motion measurements

MEDICAL SIGN-IN/CODE SLIPS typically contain:
- CPT codes with service descriptions (e.g., 97035 ULTRASOUND, 97010 HOT PACKS)
- Procedure codes for injections (e.g., 20550 SINGLE TENDON/LIGAMENT)
- Chiropractic manipulation codes (e.g., 98940, 98941)
- Treatment areas checked (cervical, thoracic, lumbar, shoulder, knee, hip)
- Billing numbers and initials

MEDICAL BILLS typically contain:
- Provider name and address
- Patient name and account number
- Itemized services with dates
- CPT/procedure codes
- Charges and payments
- Balance due

POLICE/ACCIDENT REPORTS typically contain:
- Incident/case number
- Date, time, location
- Parties involved
- Narrative description
- Officer information

PHARMACY RECORDS typically contain:
- Medication names
- Dosages
- Fill dates
- Prescribing physician
`;

export function buildPrompts(
  claimDetails: ClaimDetails,
  fileName: string,
  documentType: string,
  fileSize: number,
  processingMode: string,
  classifications?: DocumentClassification[] | null,
) {
  log('DEBUG', 'PROMPTS', 'Building analysis prompts', {
    claimNumber: claimDetails.claimNumber,
    fileName,
    documentType,
    processingMode,
    classificationCount: classifications?.length ?? 0,
  });
  
  const systemPrompt = `You are an expert insurance claims analyst with deep expertise in legal and medical document understanding.

DOCUMENT ANALYSIS FRAMEWORK:

You are analyzing a legal demand package for a bodily injury insurance claim. These packets contain MULTIPLE DOCUMENT TYPES combined into one PDF. Your job is to:

1. IDENTIFY DOCUMENT SECTIONS
   As you read through the PDF, classify each section by its content patterns:
   - Legal demand letter (attorney correspondence) - typically first few pages
   - Medical records (hospital, ER, physician, therapy notes)
   - Billing documents (itemized bills, EOBs)
   - Supporting documents (police reports, photos, wage records)

2. EXTRACT CLAIM IDENTIFIERS (Search semantically, not by page number)
   
   Claim Number:
   - Found in attorney letters, typically in "RE:" reference blocks
   - May be labeled: "Claim No.", "Claim #", "File Number", "Reference #", "Your File", "Insured Claim #"
   - Format varies: numeric (0000373065), alphanumeric (23-CV-12345), or hybrid
   - If multiple references exist, prioritize the INSURANCE COMPANY'S claim number over law firm file numbers
   - Return the COMPLETE value - never truncate

   Claimant Name:
   - In legal letters: Look for "Our Client:", "Claimant:", "RE: [Name]", "Injured Party:"
   - In medical records: "Patient Name", often in headers/footers of each page
   - Names may appear differently: "ELLIS, BOBBIE ANN" vs "Bobbie Ann Ellis"
   - Cross-reference names across documents to verify completeness
   - Return the COMPLETE legal name with ALL name parts (first, middle, last)

3. EXTRACT PATIENT DEMOGRAPHICS (Found in medical records, NOT demand letters)
   
   Date of Birth:
   - Found on hospital facesheets, ER registration forms, physician intake forms
   - Look for labels: "DOB:", "Date of Birth:", "Birth Date:", "D.O.B.", "Birthdate"
   - May appear in page headers: "DOB: 9/10/1994"
   - Formats vary: 09/10/94, 9/10/1994, September 10, 1994
   - Normalize to MM/DD/YYYY format

   Gender:
   - Found alongside DOB on demographic forms
   - Labels: "Sex:", "Gender:", "Gender Identity:", "Legal Sex:"
   - Values: F/M, Female/Male
   - Normalize to "Female" or "Male"

4. EXTRACT INCIDENT DETAILS
   
   Date of Loss/Accident:
   - In demand letters: "Date of Loss:", "Date of Accident:", "DOL:", "Date of Incident:"
   - Cross-reference with medical records (first treatment date should align)
   
   Accident Type/Description:
   - Demand letter narrative describes the incident
   - Police reports provide official details
   - Classify: Motor Vehicle Accident, Slip and Fall, Dog Bite, Assault, etc.

5. MEDICAL SUMMARY EXTRACTION
   For each medical provider section identified:
   - Provider name and specialty
   - Dates of service
   - Diagnoses (ICD codes if present)
   - Treatment provided WITH CPT CODES when available
   
   CPT CODE EXTRACTION (Critical for billing analysis):
   - Look for medical sign-in sheets and code slips
   - Extract CPT codes alongside service names: "Ultrasound (CPT 97035)"
   - Common therapy CPT codes: 97035 (Ultrasound), 97010 (Hot/Cold Packs), 97014 (Electric Stim), 97140 (Manual Therapy), 97012 (Traction)
   - Common chiropractic codes: 98940-98943 (Spinal Manipulation by region count)
   - Common injection codes: 20550-20553 (Trigger Point), 64493-64495 (Facet Injections)
   - Include CPT codes in the postAccidentRecap summary for each provider
   - Recommendations/referrals

6. CROSS-DOCUMENT VALIDATION
   - Verify claimant name is consistent across all documents (note variations)
   - Confirm DOB matches between legal docs and medical records
   - Check date of loss aligns with first treatment date
   - Flag any discrepancies found

7. PAGE CITATION RULES - MANDATORY
   - Every extracted fact MUST include page reference
   - Format: "(p. X)" for single page, "(pp. X-Y)" for range
   - If information not found: "Not found (searched entire document)"
   - Include page range searched when reporting missing data

8. SELF-CONSISTENCY VALIDATION - CRITICAL FINAL STEP
   Before finalizing your response, you MUST perform a self-consistency check:
   
   a) Review ALL extracted data in extractedIdentifiers, headerInfo, and other sections
   b) Compare against flags[] and recommendedActions[] you're about to output
   c) REMOVE any flag that contradicts successfully extracted data:
      - If DOB was found and placed in extractedIdentifiers.dateOfBirth, do NOT add a flag saying "DOB not found"
      - If Gender was found and placed in extractedIdentifiers.gender, do NOT add a flag saying "Gender not found"
      - If claimant name was extracted, do NOT flag it as missing
   d) Only flag items as "not found" if they are ACTUALLY missing from ALL output sections
   e) Flags should highlight genuine concerns, NOT contradict your own successful extractions
   
   CONTRADICTION PREVENTION CHECKLIST (MANDATORY):
   Before generating ANY flag or recommended action, you MUST verify:
   
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │ FIELD EXTRACTED?          │ THEN YOU MUST NOT FLAG AS MISSING              │
   ├─────────────────────────────────────────────────────────────────────────────┤
   │ headerInfo.demandAmount   │ NO flags about "demand letter", "settlement    │
   │   has a value             │   amount", or "demand amount" being missing    │
   ├─────────────────────────────────────────────────────────────────────────────┤
   │ imagingResults[] has      │ NO flags about "radiology reports missing",    │
   │   entries with findings   │   "imaging findings not included", or          │
   │                           │   "radiology findings unavailable"              │
   ├─────────────────────────────────────────────────────────────────────────────┤
   │ providerDetails[] has     │ NO flags about "treatment records missing",    │
   │   entries OR              │   "provider records unavailable", or           │
   │ postAccidentRecap[] has   │   "medical records not found"                  │
   │   entries                 │                                                 │
   ├─────────────────────────────────────────────────────────────────────────────┤
   │ medicalBillBreakdown[]    │ NO flags about "billing records missing" or    │
   │   has entries             │   "itemized bills not included"                │
   ├─────────────────────────────────────────────────────────────────────────────┤
   │ diagnosedInjuries[] has   │ NO flags about "injuries not documented" or    │
   │   entries                 │   "diagnosis information missing"              │
   └─────────────────────────────────────────────────────────────────────────────┘
   
   CONTRADICTION EXAMPLES TO AVOID:
   ❌ headerInfo.demandAmount = "Policy limits of $250,000/$500,000 (p. 3)" AND flags contains "No explicit demand letter or settlement amount is present"
   ❌ imagingResults[] has 5 entries with full findings AND flags contains "Detailed radiology reports with findings are not included"
   ❌ extractedIdentifiers.dateOfBirth = "09/10/1994" AND flags contains "DOB not found"
   ❌ providerDetails[] or postAccidentRecap[] has provider entries AND flags contains "Treatment records missing"
   
   ✅ If data IS extracted, the flag should instead note WHERE it was found or any variations
   ✅ Only flag items that are GENUINELY missing from your extraction output
   
   PRE-OUTPUT VERIFICATION CHECKLIST:
   Before generating flags[] and recommendedActions[], fill out preOutputValidation:
   - List each key field and whether you found it
   - For each "found: true" field, you are FORBIDDEN from adding a "not found" flag
   - Only THEN generate your flags[] based on genuinely missing information

9. **STRUCTURED EXTRACTION FOR TREATMENT RECAP**:
   - The treatmentRecap section REQUIRES both narrative AND fully populated arrays
   - providerDetails array: Extract EVERY provider mentioned (hospitals, doctors, clinics, transportation)
   - imagingResults array: Extract EVERY imaging study with FULL findings/impressions from radiology reports
   - DO NOT write only a narrative and leave arrays empty
   - If treatment information exists, arrays MUST be populated
   - Each provider entry must include: name, specialty, dateRange, visits, treatmentsProvided (with CPT codes), pageRefs
   - Each imaging entry must include: type, bodyPart, date, COMPLETE findings (verbatim from report), pageRef

10. **ADJUSTER-FACING EXTRACTION** (NEW — populate when content is present):

    a) **facts_of_loss** (string, 1-3 sentences, source-quoted)
       - Look in FNOL "Loss Description" / "Statement of Loss" / "Narrative" sections
       - Look in police report narrative
       - Look in demand letter incident-description paragraphs
       - PARAPHRASE faithfully — do NOT speculate beyond the document
       - Examples:
         "The insured was traveling SB on Hwy 9 at the 42 MM and veered left, crossing into oncoming traffic and striking the OV. The insured reports he may have lost consciousness due to fatigue from working 7 days a week. (p. 5)"
         "W/B insured failed to yield at a stop sign causing collision with claimant's E/B semi tractor. (p. 1)"
       - If the doc has no such content, return null. Don't fabricate.

    b) **liability_signals** (object — only fill what the document actually states)
       - at_fault_party: name/role of at-fault party (e.g. "insured", "claimant", "third-party driver")
       - traffic_violation_cited: any traffic citation, code violation, or failure-to-yield language
       - fault_admission_quoted: verbatim admission if present
       - is_liability_clear: "Yes" / "No" / "Disputed" — extract from FNOL "Is liability clear?" or equivalent
       - contributing_factors: array of factors named in the doc (fatigue, intoxication, weather, road condition, etc.)
       - evidence_sources: array of doc sources cited (police report, witness statement, dash cam, etc.)
       - Return null fields when the document is silent on a given attribute.

    c) **policy_limits** (string)
       - From declarations_page: full coverage breakdown
       - From FNOL "Coverage Information" / "BI Coverage is X/Y": pull verbatim
       - Examples: "BI Coverage 100/300; PD 50; UM 100/300; Med-Pay 5K"
       - If only one coverage line is present: "BI 100/300 (other coverages not stated in this doc)"

    d) **impact_severity_signals** (object — ONLY from medical records / FNOL / police report)
       - mva_severity: "light" / "moderate" / "heavy" — heavy if any of: vehicle totaled, ambulance from scene, LOC, airbag deployment, ejection
       - totaled_vehicle: boolean — true if "totaled", "total loss", "non-drivable"
       - ambulance_transport: boolean
       - loss_of_consciousness: boolean (LOC)
       - airbag_deployed: boolean
       - prior_visits_count_before_incident: integer | null — count of clinic visits to providers in the year BEFORE the date of loss
       - mri_findings_severity: "none" / "degenerative_only" / "disc_bulge" / "disc_herniation" / "acute_fracture" / "torn_ligament" — strongest finding mentioned

    e) **treatment_intensity_signals** (object)
       - visit_count: integer | null — total visits across all providers in this doc
       - treatment_span_months: number | null — months from first to last visit
       - surgery_performed: boolean
       - injections_received: boolean
       - injection_count: integer | null
       - imaging_count: integer | null — number of MRI/CT/X-ray studies
       - mmi_reached: boolean — true if any provider noted MMI (maximum medical improvement)
       - referral_to_specialist: boolean — referrals to ortho, neuro, pain mgmt, surgeon

    f) **provider_visit_details** (array — ENRICHED, when this is a medical record doc)
       - One entry per provider per visit (or per provider per date range if visits are aggregated in the source)
       - Each entry: { date, provider, chief_complaint, exam_findings_quoted (verbatim 1-3 sentences), impressions_quoted (verbatim from impression/assessment section), plan_quoted (verbatim from plan section), page_ref }
       - For radiology: impressions_quoted is the radiologist's IMPRESSION/CONCLUSION verbatim
       - For PT/Chiro: impressions_quoted captures pain levels, ROM measurements, MMI notes
       - This is what feeds the BI-SUMMARY "MEDICAL RECORD RECAP BY PROVIDER" section. Verbatim quotes are required where the source uses specific clinical language.

    g) **bills enrichment** (when this is a bills doc, extend medicalBillBreakdown entries)
       - lien_holder: string | null (e.g. "The Rawlings Co", "Medicare")
       - paid_by_insurance_amount: string | null
       - insurance_offsets_noted: array of strings (mentions of PIP, Med-Pay, WC, health insurance offsets)
       - total_billed: string — sum across the bill doc
       - total_atty_claimed: string | null — if the bill doc or accompanying demand letter cites an attorney-totaled figure

${DOCUMENT_RECOGNITION_PATTERNS}

CRITICAL RULES:
1. SEMANTIC UNDERSTANDING: Find data by meaning and context, not fixed page locations
2. COMPLETENESS: Fill out EVERY section thoroughly. No placeholder text.
3. NO DUPLICATES: Each section has unique info only
4. CONFIDENCE TRACKING: Report certainty (0.0-1.0) for each extracted value
5. CROSS-VALIDATION: Verify key facts appear consistently across document sections
6. SELF-CONSISTENCY: Flags and notes must NOT contradict successfully extracted data
7. CONTRADICTION PREVENTION: Before adding ANY flag, verify the data isn't already in your extraction output`;

  const userPrompt = `Analyze this ${documentType} document. File: ${fileName}, Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB
${buildClassificationsHint(classifications)}
EXISTING CLAIM CONTEXT (may be placeholders - extract actual values from document):
Claimant: ${claimDetails.claimantName}
Claim Type: ${claimDetails.claimType}
Incident Date: ${claimDetails.incidentDate}
Incident: ${claimDetails.incidentDescription}
Location: ${claimDetails.accidentLocation || 'Not specified'}

SEMANTIC EXTRACTION INSTRUCTIONS:

1. DOCUMENT STRUCTURE - Map the PDF sections:
   - Identify where each document type begins/ends
   - Note the page ranges for each section type

2. CLAIM IDENTIFIERS - Search the ENTIRE document:
   - Find claim number in legal correspondence (RE: blocks, reference lines)
   - Find claimant's FULL legal name (check "Our Client", patient records, headers)
   - Verify name consistency across all documents

3. PATIENT DEMOGRAPHICS - Search MEDICAL RECORDS:
   - Find DOB on hospital facesheets, ER forms, physician notes
   - Find Gender in same demographic sections
   - These are NOT in the demand letter - look in actual medical records

4. INCIDENT DETAILS - Extract from demand letter narrative and police reports

Return JSON with structured extraction including page classifications:

{
  "summary": "Brief relevance summary",
  
  "documentStructure": {
    "totalPages": 0,
    "sections": [
      {
        "pageRange": "1-3",
        "type": "legal_demand_letter",
        "description": "Attorney demand letter",
        "keyDataFound": ["claim_number", "claimant_name", "date_of_loss"]
      }
    ]
  },
  
  "extractedIdentifiers": {
    "claimNumber": {
      "value": "Full claim number",
      "source": "Document type where found",
      "pageRef": "1",
      "confidence": 0.98
    },
    "claimantName": {
      "value": "Full legal name with all parts",
      "variations": ["Other name formats found"],
      "source": "Document type where found",
      "pageRef": "1, 12",
      "confidence": 0.95
    },
    "dateOfBirth": {
      "value": "MM/DD/YYYY — extract from ANY document that states a DOB (medical records, hospital facesheet, ER, intake/demographic forms, demand letter)",
      "source": "Document type where the DOB appears",
      "pageRef": "12",
      "confidence": 0.99
    },
    "gender": {
      "value": "Female / Male — PREFER an explicit Gender/Sex field from ANY document (medical records, facesheet, ER, intake/demographic forms). ONLY if no document states it, infer from the claimant honorific (Ms./Mrs. -> Female, Mr. -> Male). Else 'unknown'.",
      "source": "Explicit Gender/Sex field, or 'inferred from honorific'",
      "pageRef": "12",
      "confidence": 0.99
    },
    "dateOfLoss": {
      "value": "MM/DD/YYYY",
      "source": "Demand letter",
      "pageRef": "1",
      "confidence": 0.97
    }
  },
  
  "crossDocumentValidation": {
    "nameConsistency": "verified|discrepancy",
    "dobConsistency": "verified|discrepancy",
    "dateOfLossAlignment": "verified|discrepancy",
    "discrepancies": []
  },
  
  "extractedClaimNumber": "FULL claim number (backup field)",
  "extractedClaimantName": "FULL name (backup field)",
  "extractedDateOfBirth": "DOB from ANY doc that states it — medical records, facesheet, ER, intake forms, demand letter (backup field)",
  "extractedGender": "Gender: explicit Gender/Sex field from ANY doc FIRST; else infer from honorific (Ms./Mrs.->Female, Mr.->Male); else 'unknown' (backup field)",
  "extractedClaimType": "Motor Vehicle Claim/Slip and Fall/etc.",
  
  "headerInfo": {
    "claimNumber": "FULL claim number (p. X)", 
    "dateCompleted": "Today", 
    "completedBy": "AI Analysis & Adjuster", 
    "claimantFullName": "Complete legal name (p. X)",
    "dateOfBirth": "From ANY doc stating a DOB — demographics, facesheet, ER, intake, demand letter (p. X)",
    "gender": "Explicit Gender/Sex field from ANY doc FIRST; else infer from honorific Ms./Mrs.->Female, Mr.->Male; else 'unknown' (p. X)",
    "namedobGender": "Full Name, DOB MM/DD/YYYY, Gender (p. X)",
    "seatbelt": "Yes/No/Unknown (p. X)",
    "accidentLocation": "(p. X)",
    "dateOfAccident": "(p. X)",
    "accidentType": "(p. X)",
    "attorneyRepresented": "Yes - <Law Firm Name from letterhead/signature block> / No (p. X)",
    "timeLimitDemand": "A CLAIMANT/attorney response or settlement deadline in a demand letter OR attorney correspondence, e.g. 'September 15, 2025' / 'within 30 days'. NOT an insurer IME/records-request/denial deadline or HIPAA 'respond within 30 days' boilerplate (p. X)",
    "demandAmount": "The CLAIMANT/attorney demanded settlement sum in a demand letter OR attorney correspondence, e.g. '$100,000' / 'policy limits'. NOT a reserve, PIP/Med-Pay paid, or medical-bill total (p. X)",
    "confidence": 0.0
  },
  
  "diagnosedInjuries": [{"injury": "Description (p. X)", "scarringNoted": false, "pageRef": "X"}],
  "diagnosedInjuriesConfidence": 0.0,
  "priorInjuries": "Details (p. X) or 'None documented (searched pp. X-Y)'",
  "priorInjuriesConfidence": 0.0,

CRITICAL TREATMENT RECAP EXTRACTION INSTRUCTIONS:
The treatmentRecap section is MANDATORY and requires BOTH narrative AND fully populated structured arrays.

YOU MUST POPULATE THESE ARRAYS - DO NOT LEAVE THEM EMPTY:
1. providerDetails array: Extract EVERY provider mentioned (hospitals, doctors, clinics, transportation services)
   - Create ONE entry for EACH provider
   - Include: name, specialty, dateRange, visits, treatmentsProvided (with CPT codes), pageRefs

2. imagingResults array: Extract EVERY imaging study with FULL findings/impressions
   - Create ONE entry for EACH imaging study (CT, MRI, X-ray, Ultrasound, etc.)
   - Include: type, bodyPart, date, COMPLETE findings (verbatim from radiology report), pageRef

EXAMPLE - If document mentions "Tampa General Hospital provided ER care on 06/27/2025 with X-rays and CT scans" and later "Chambers Medical Group - Dr. Smith provided chiropractic care from 07/01/2025 to 08/15/2025 including Ultrasound (CPT 97035), Electric Stim (CPT 97014)", you would return:

"treatmentRecap": {
  "narrative": "Patient received emergency care at Tampa General Hospital on 06/27/2025 with diagnostic imaging (X-rays, CT scans). Subsequently underwent chiropractic treatment at Chambers Medical Group with Dr. Smith from 07/01/2025 to 08/15/2025, including ultrasound and electric stimulation therapies (pp. 5-20).",
  "providerDetails": [
    {
      "name": "Tampa General Hospital",
      "specialty": "Emergency",
      "dateRange": "06/27/2025",
      "visits": "1",
      "treatmentsProvided": ["Emergency evaluation", "X-rays", "CT scans"],
      "pageRefs": "pp. 5-8"
    },
    {
      "name": "Chambers Medical Group - Dr. Smith",
      "specialty": "Chiropractic",
      "dateRange": "07/01/2025 - 08/15/2025",
      "visits": "12",
      "treatmentsProvided": ["Ultrasound (CPT 97035)", "Electric Stimulation (CPT 97014)", "Spinal Manipulation"],
      "pageRefs": "pp. 10-20"
    }
  ],
  "imagingResults": [
    {
      "type": "CT Cervical Spine",
      "bodyPart": "Cervical Spine",
      "date": "06/27/2025",
      "findings": "Impression: no acute fracture or traumatic malalignment. Well-corticated osseous fragment at the inferior aspect of the anterior arch of C1, which may represent remote fracture.",
      "pageRef": "p. 8"
    },
    {
      "type": "X-ray Shoulder",
      "bodyPart": "Right Shoulder",
      "date": "06/27/2025",
      "findings": "Impression: no significant abnormality identified. No acute fracture or dislocation.",
      "pageRef": "p. 8"
    }
  ],
  "prognosisAssessment": {
    "prognosis": "Permanent injury with ongoing treatment needs",
    "impairmentRating": "12% whole person impairment",
    "futureExpenses": "$2,000 annually",
    "pageRef": "p. 29"
  },
  "surgery": false,
  "surgeryDetails": "",
  "injections": false,
  "injectionsDetails": "",
  "totalVisits": "13",
  "confidence": 0.95
}

NOW RETURN YOUR ACTUAL EXTRACTION in this format (NO COMMENTS in the JSON):

  "treatmentRecap": {
    "narrative": "High-level treatment summary across all providers (pp. X-Y)",
    "providerDetails": [
      {
        "name": "Provider Name",
        "specialty": "Emergency, Chiropractic, Physical Therapy, Physician, Radiology, etc.",
        "dateRange": "MM/DD/YYYY - MM/DD/YYYY",
        "visits": "Number or description",
        "treatmentsProvided": ["Treatment 1 (CPT XXXXX)", "Treatment 2 (CPT XXXXX)"],
        "pageRefs": "pp. X-Y"
      }
    ],
    "imagingResults": [
      {
        "type": "MRI/CT/X-ray/Ultrasound",
        "bodyPart": "Body area examined",
        "date": "MM/DD/YYYY",
        "findings": "COMPLETE findings from radiology report verbatim",
        "pageRef": "p. X"
      }
    ],
    "prognosisAssessment": {
      "prognosis": "Description of permanent injury, impairment ratings, future treatment needs",
      "impairmentRating": "Percentage or rating",
      "futureExpenses": "Dollar amount and frequency",
      "pageRef": "p. X"
    },
    "surgery": false,
    "surgeryDetails": "Procedure description if yes (p. X)",
    "injections": false,
    "injectionsDetails": "Type and location if yes (p. X)",
    "totalVisits": "Number",
    "confidence": 0.0
  },
  "impactToLife": "Specific impacts (pp. X-Y) or 'Not documented (searched pp. X-Y)'",
  "impactToLifeConfidence": 0.0,
  "claimedWageLoss": "$X, period, employer (p. X) or 'Not documented (searched pp. X-Y)'",
  "claimedWageLossConfidence": 0.0,
  "medicalBillBreakdown": [{"date": "", "provider": "", "complaintsOrDiagnosis": "", "type": "", "amountBilled": "", "healthInsurancePaid": "", "lien_holder": null, "paid_by_insurance_amount": null, "pageRef": "X"}],
  "medicalBillBreakdownConfidence": 0.0,
  "billsSummary": {
    "total_billed": "$X (sum across this doc) or null",
    "total_atty_claimed": "$X or null",
    "insurance_offsets_noted": ["e.g. 'PIP $30K', 'Med-Pay $5K', 'WC pending'"]
  },
  "postAccidentRecap": [{"provider": "", "summary": "(pp. X-Y) - MUST include CPT codes with services when found, e.g., 'Ultrasound (CPT 97035), Hot Packs (CPT 97010), Electric Stim (CPT 97014), Chiropractic Manipulation (CPT 98941)'", "cptCodes": ["97035", "97010"], "pageRefs": ""}],
  "postAccidentRecapConfidence": 0.0,
  "preAccidentRecap": [{"provider": "", "summary": "(p. X)", "cptCodes": [], "pageRefs": ""}],
  "preAccidentRecapConfidence": 0.0,

  "facts_of_loss": "1-3 sentence paraphrase of the loss description if this is FNOL/police_report/demand_letter/correspondence — null otherwise",
  "liability_signals": {
    "at_fault_party": null,
    "traffic_violation_cited": null,
    "fault_admission_quoted": null,
    "is_liability_clear": null,
    "contributing_factors": [],
    "evidence_sources": []
  },
  "policy_limits": "From declarations_page OR FNOL 'Coverage Information' block (string, verbatim phrasing) or null",
  "impact_severity_signals": {
    "mva_severity": null,
    "totaled_vehicle": null,
    "ambulance_transport": null,
    "loss_of_consciousness": null,
    "airbag_deployed": null,
    "prior_visits_count_before_incident": null,
    "mri_findings_severity": null
  },
  "treatment_intensity_signals": {
    "visit_count": null,
    "treatment_span_months": null,
    "surgery_performed": null,
    "injections_received": null,
    "injection_count": null,
    "imaging_count": null,
    "mmi_reached": null,
    "referral_to_specialist": null
  },
  "provider_visit_details": [
    {
      "date": "MM/DD/YYYY",
      "provider": "Provider name",
      "chief_complaint": "Patient's stated complaint, verbatim or close paraphrase",
      "exam_findings_quoted": "1-3 sentence verbatim from the exam findings section",
      "impressions_quoted": "Verbatim from impression/assessment section (radiology IMPRESSION, physician ASSESSMENT, PT ROM/MMI notes)",
      "plan_quoted": "Verbatim from plan/recommendation section",
      "page_ref": "p. X"
    }
  ],
  "verification": {"status": "verified|needs_review|rejected", "dateAlignment": "", "nameMatch": "", "injuryConsistency": "", "costReasonableness": "", "notes": "", "confidence": 0.0},
  "preOutputValidation": {
    "extractedFields": {
      "dateOfBirth": { "found": true, "value": "09/10/1994", "pageRef": "12" },
      "gender": { "found": true, "value": "Female", "pageRef": "12" },
      "claimantName": { "found": true, "value": "Full Name", "pageRef": "1, 12" },
      "claimNumber": { "found": true, "value": "0000373065", "pageRef": "1" }
    },
    "flagsReview": "Before adding flags, I verified: DOB found on p.12, Gender found on p.12, Name found on p.1. Flags should NOT mention these as missing."
  },
  "flags": ["Only genuinely missing items or concerns (p. X)"],
  "recommendedActions": ["Only actions for items NOT successfully extracted"],
  "confidenceScore": 0.0
}`;

  log('DEBUG', 'PROMPTS', 'Prompts built', {
    systemPromptLength: systemPrompt.length,
    userPromptLength: userPrompt.length
  });

  return { systemPrompt, userPrompt };
}
