// Cross-document synthesis pass. Runs after all sibling documents on a
// claim have finished per-document analysis, and reconciles the per-doc
// extractions into a single claim-level view.
//
// The synthesis result is stored in claims.ai_synthesis (jsonb). Where a
// reconciled field has high confidence and the matching claims column is
// currently null/blank, the column is also stamped — but the canonical
// source of truth is always the synthesis JSON.
//
// Triggered by:
//   - analyze-claim-document, when the final sibling doc completes
//   - reload-claim-from-sor, after a successful re-pull
//   - sor-sync's pending_content sweep, when a doc's content lands
//
// Safe to call repeatedly — it's idempotent and overwrites prior synthesis.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateWithInlineContent, type GeminiPart } from "../_shared/gemini.ts";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";
import { storagePathFromFileUrl } from "../_shared/storage-path.ts";
import { diffAnalysis } from "../_shared/analysis-diff.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// Chunked ArrayBuffer -> base64 (avoids String.fromCharCode stack overflow on
// multi-MB PDFs). Used for the best-effort demand-letter re-read below.
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "X-Content-Type-Options": "nosniff",
};

const SYNTHESIS_MODEL = "gemini-2.5-pro";

const SYSTEM_PROMPT = `You are reconciling extracted data from multiple documents that all relate to a single insurance claim. Each document was analyzed independently by an earlier pass, then graded by an Anthropic-driven grounding pass. Your job is to produce ONE canonical view of the claim — a SINGLE consolidated summary that spans all documents, with deduplicated providers / injuries / bills and reconciled facts.

This output drives ONE InjuryTreatmentSummary card per claim in the UI. There is no per-document card. Your output IS the entire reviewer-facing analysis.

INPUT PER DOCUMENT:
- file_name, doc_id, document_type (primary classification)
- document_classifications: array of {type, pageStart, pageEnd, confidence} — page-range labels from Pass 0
- grounding_status: "passed" | "partial" | "failed" | "skipped_oversize" | "not_run"
- grounding_score: 0-1 (null when not graded)
- extracted analysis JSON (the per-doc Gemini output — has headerInfo, diagnosedInjuries, treatmentRecap, medicalBillBreakdown, etc.)

WEIGHTING RULES (apply IN ORDER — these matter):
0. **Known claim metadata is AUTHORITATIVE.** The user prompt may begin with a "KNOWN CLAIM METADATA" block listing fields pulled from the source system (Sor) or set by a human in the portal. When any of those fields is present and non-empty, USE it as the synthesized value for the matching output field — even if per-doc extractions are silent or contradicting. NEVER overwrite a known metadata value with null. Specifically:
   - known claim_number → output.claim_number AND output.headerInfo.claimNumber
   - known claimant_name → output.claimant_name AND a parties[] entry with role "Insured" AND output.headerInfo.namedobGender (see special rule below)
   - known policy_number → output.policy_number
   - known incident_date → output.incident_date AND output.headerInfo.dateOfAccident (reformat to MM/DD/YYYY)
   - known incident_description → output.incident_description (per-doc analyses can ENRICH this with more detail, but the known value's facts are the spine)
   - known accident_location → output.accident_location AND output.headerInfo.accidentLocation
1. **Trust grounding signal next.** passed > partial > failed > not_run. A value from one passed-grounding doc is MORE trustworthy than a value agreed on by two failed-grounding docs. (This applies to fields NOT covered by the known-metadata block above.)
2. **Match field domain to source-doc type.**
   - treatmentRecap.* / diagnosedInjuries / postAccidentRecap / preAccidentRecap → medical_record / physician_notes / er_record / operative_report / radiology_report / physical_therapy / medical_signin_slip / hospital_facesheet ONLY
   - demand_total / demandAmount / timeLimitDemand → a CLAIMANT/attorney settlement demand, found in a demand_letter OR attorney correspondence. A demand is the claimant side demanding a settlement sum and/or a response deadline FROM the insurer. DO NOT source these from insurer-originated letters (IME notices, records requests, coverage/PIP denials, reservation of rights), HIPAA "respond within N days" records-request boilerplate, internal reserves, PIP amounts paid, or medical-bill totals.
   - impactToLife / claimedWageLoss → demand_letter (best) or medical_record secondary
   - incident_date / dateOfAccident / accident_location → fnol / declarations_page / police_report / demand_letter (skipped when known metadata supplies them)
   - claim_number / policy_number / claimant_name → any doc; prefer claim metadata docs (skipped when known metadata supplies them)
   - If the only source for a medical field is a correspondence/FNOL doc, that field is suspect — flag in conflicts.
3. **DEDUPLICATE across documents.** If two docs both list "Dr. Smith — 12 visits", emit ONE provider entry, not two. Bills with the same (provider, date, amountBilled) collapse to one row. Injuries describing the same body part with similar wording merge into one entry (prefer the more specific phrasing).
4. **SUM where it makes sense.** treatmentRecap.totalVisits is the sum across ALL providers' visits across ALL docs. Surgery / injections boolean = TRUE if ANY doc reports one.
5. **Never invent.** If no doc supplies a field, return null. Don't guess. (Note: rule 0 is the deliberate exception — known metadata isn't guessing.)

SPECIAL RULE — headerInfo.namedobGender:
The format is "NAME | DOB <date or 'unknown'> | Gender <M/F/'unknown'>". This is a STRING field, not three separate fields. Emit it as soon as the NAME is known, even if DOB and Gender aren't. Examples:
  - Known name only:                  "BUNDY, JAMES | DOB unknown | Gender unknown"
  - Known name + DOB:                 "BUNDY, JAMES | DOB 03/15/1972 | Gender unknown"
  - All three known:                  "EVANS, CHAD | DOB 09/10/1985 | Male"
Return null ONLY if even the name is unknown.

SPECIAL RULE — DOB & Gender precedence (feeds namedobGender):
- DOB: use any doc's explicit date of birth (per-doc extractedDateOfBirth, extractedIdentifiers.dateOfBirth.value, or headerInfo.dateOfBirth). Take the first confident value; format MM/DD/YYYY.
- Gender: PREFER an explicit Gender/Sex value stated in ANY doc (extractedGender, extractedIdentifiers.gender.value, headerInfo.gender). ONLY if NO doc states gender, infer it from the claimant honorific found in the name or any demand/correspondence letter ("Ms." or "Mrs." -> Female, "Mr." -> Male). If still unknown, use "unknown".

SPECIAL RULE — attorneyRepresented, timeLimitDemand & demandAmount (demand_letter / correspondence sources):
- attorneyRepresented: if any demand_letter or correspondence doc shows a law-firm letterhead or attorney signature block, emit "Yes - <Firm Name>" using the firm name (e.g. "Yes - Schneider Law"). Use "No" only when represented-status is clearly absent. NEVER emit "Yes - Firm name not specified" when a firm name appears anywhere in a demand/representation letter — extract it.
- What counts as a DEMAND: the CLAIMANT (or their attorney) demanding settlement FROM the insurer — a specific dollar sum (demandAmount) and/or a response/settlement deadline (timeLimitDemand). It may appear in a formal demand_letter OR in attorney correspondence. It is NOT an insurer-originated letter (IME notice, records request, PIP/coverage denial, reservation of rights), NOT HIPAA "respond within N days" records-request boilerplate, NOT an internal reserve, NOT PIP/Med-Pay paid, NOT a medical-bill total, and NOT a coverage/policy limit unless the claimant explicitly demands that amount.
- timeLimitDemand: the claimant/attorney response or settlement deadline (e.g. "September 15, 2025", "within 30 days of this letter"), usually on the last page of a demand. null if no genuine claimant demand sets one.
- demandAmount: the claimant/attorney demanded settlement sum, human-formatted (e.g. "$100,000", "policy limits"). null if no genuine claimant demand is present.
- VERIFIED ABSENCE: if the sources were read and there is NO genuine claimant demand (e.g. the file is still awaiting the demand, or only insurer-originated letters exist), leave BOTH timeLimitDemand and demandAmount null. That is a confirmed absence, not a gap to flag.

SPECIAL RULE — preAccidentRecap / postAccidentRecap (aggregate, don't leave empty):
Aggregate EVERY medical doc's per-provider recap into these two arrays, DEDUPLICATED by provider. The boundary is the accident/incident date: care DATED ON OR AFTER it goes in postAccidentRecap; care clearly BEFORE it (prior/pre-existing records) goes in preAccidentRecap. Source from each doc's postAccidentRecap/preAccidentRecap arrays AND, when those are empty, from provider_visit_details and treatmentRecap.providerDetails. Each row = { "provider": string, "summary": string (1-4 sentences: chief complaint, key findings/impressions, plan — include CPT codes when present), "cptCodes": [string]|null, "pageRefs": string|null }. Do NOT return empty arrays when medical documents exist.

SPECIAL RULE — flags (reviewer-facing notes):
Use "flags" ONLY for substantive review concerns a human adjuster should check (e.g. "At-fault party's policy limits are not documented.", "Causation between the accident and the chronic syndromes needs evaluation."). Write every flag in PLAIN ENGLISH — NEVER reference a raw field name or path (no "headerInfo.x", no camelCase field names). Do NOT add flags about missing claimant name/DOB/gender, attorney, or time-limit demand — those header-field gaps are detected automatically downstream, so omit them here.

SPECIAL RULE — recommendedActions (adjuster next-steps):
Populate "recommendedActions" with 3–7 concrete, prioritized next steps a claims adjuster should take to MOVE THIS CLAIM FORWARD — grounded in its specifics, never generic boilerplate.

GROUND EVERY ACTION IN WHAT IS ALREADY EXTRACTED. Before recommending to OBTAIN a document or figure, CHECK whether it is already present in this synthesis (e.g. medicalBillBreakdown, policyLimits, treatmentRecap, the per-provider recaps, wage-loss fields). If the data IS already in the record, do NOT say "obtain/get/request" it — frame the action as "Reconcile/verify ..." instead. Concretely: if medicalBillBreakdown already has line items, NEVER recommend "obtain the medical bill ledger"; recommend "Reconcile the documented provider bills (≈ $<sum of medicalBillBreakdown>) against the $<claimed total> demanded, and resolve any gap/duplication." Reserve "Obtain ..." strictly for items genuinely absent from the documents.

Draw from:
- Documentation: "Obtain ..." ONLY for what's missing (e.g. at-fault policy limits when policyLimits is null); otherwise "Reconcile/verify ..." what's present.
- Investigation: e.g. "Order an IME (or peer/records review) — causation is disputed given significant pre-existing conditions", "Request prior medical records to establish a pre-accident baseline", "Take the claimant's recorded statement / EUO".
- Liability & coverage follow-ups grounded in the liability signals.
- Deadlines: when a time-limit demand exists, ALWAYS include "Calendar and respond to the time-limit demand by <date> (per the demand letter)".
- High-exposure handling: e.g. "Re-evaluate reserves against the $X demand and the injury profile" when the demand is large relative to documented specials.
Make each action specific (name the document, party, deadline, or issue). Write in plain English (no field names). Do NOT include pure data-extraction fixes (those are handled elsewhere) — these are real handling actions. A complex or high-value claim should always have substantive next steps; a genuinely routine, fully-documented claim may have fewer.

SPECIAL RULES — adjusterPortion:

A) **factsOfLoss source priority**: pick ONE source doc in this priority order: fnol > police_report > demand_letter > correspondence. Use that doc's facts_of_loss field verbatim/paraphrased. Do NOT synthesize across multiple docs (this would invent details). Stamp _provenance.factsOfLoss.source_doc_id with the chosen doc_id.

B) **liability.draft requirements**: only fill draft if AT LEAST ONE doc has a non-empty liability_signals.at_fault_party OR liability_signals.traffic_violation_cited OR liability_signals.is_liability_clear. If no doc supplies these, set draft=null and confidence="insufficient_data" with a caveat listing what's missing.

C) **Dollar-range multiplier table** (use for generals + perInjuryGenerals + totalRange):

   Base multiplier (applied to total medical bills × multiplier):
   | Injury profile                                          | Multiplier  |
   |--------------------------------------------------------|-------------|
   | Soft-tissue only (strain/sprain, <3 mo PT)             | 0.10 – 0.30 |
   | Soft-tissue + injection                                | 0.20 – 0.50 |
   | MRI-confirmed disc bulge/herniation + PT (non-surgical)| 0.40 – 0.80 |
   | Surgery performed                                      | 0.80 – 2.0  |
   | Fracture confirmed, non-surgical                       | 0.50 – 1.20 |

   Impact tier modifier (multiply the base):
   | Impact (from impact_severity_signals.mva_severity) | Modifier |
   |---------------------------------------------------|----------|
   | light                                              | × 1.0    |
   | moderate                                           | × 1.15   |
   | heavy                                              | × 1.30   |

   The medicalBillBreakdown you output above IS the bills source. If it has ANY entry with a numeric amountBilled, total medical bills ARE KNOWN — you MUST compute them and apply the multiplier. Compute total_medical = sum of amountBilled across MEDICAL TREATMENT entries only: EXCLUDE non-medical / offset / damages items (PIP offsets, subrogation interest, liens, travel, supplements, lifestyle costs) and DE-DUPLICATE providers so the same bill is not counted twice (e.g. a provider listed both as a per-visit total and a lump sum — use the more complete single figure, not both). NEVER set the range null with a "no medical bills were provided" caveat when medicalBillBreakdown is non-empty. Leave range_low/range_high null (and explain) ONLY when medicalBillBreakdown is genuinely empty.

D) **Every dollar field requires a caveat string**. Mandatory wording prefix: "AI draft — ". Example full caveat: "AI draft — multipliers approximate, not jurisdiction-tuned, no historic settlement data factored in."

E) **_provenance entries required for new fields**:
   - factsOfLoss → source_doc_id (single doc chosen)
   - liability.draft → array of doc_ids contributing liability_signals
   - increasingFactors.narrative → array of doc_ids contributing impact + treatment signals
   - generals.range_low/high → bills source doc_ids
   - policyLimits → declarations_page or FNOL doc_id

F) **perInjuryGenerals**: one entry per diagnosedInjuries entry. Each entry's range = (bills allocated to that injury, or proportional split if not clear) × applicable multiplier. If can't be allocated, set range_low/high to null and explain in rationale.

G) **Internal-only fields**: leave currentReserves and reservesOk as null. These are strategic decisions for the adjuster, not extractable from PDFs.

CITATION RULES — MANDATORY:
Every "pageRef" / "pageRefs" value MUST cite the DOCUMENT BY ITS file_name followed by the page, formatted EXACTLY: "<file_name> p. <N>" (single page) or "<file_name> pp. <N>-<M>" (range). Use the file_name shown in each document's header (e.g. "sor-doc-116389047.pdf"). NEVER put a doc_id UUID in a pageRef — UUIDs belong ONLY in the _provenance "doc_id"/"source_doc_id" fields. Do NOT wrap the value in parentheses; emit just "sor-doc-116389047.pdf p. 2". If you genuinely cannot tie a fact to a specific page, set the pageRef to null rather than inventing one.

CLAIM TYPE — infer "claim_type" (one of exactly: "auto", "home", "farm", "life"):
Decide from incident_description, the policy-number prefix, and document content. Heuristics:
  - motor-vehicle / collision / rear-end / MVA, OR policy prefix PAND/OAND/PASD → "auto"
  - homeowner property loss (water/plumbing/appliance leak, fire, hail, wind, theft, residential liability), OR policy prefix HOND/FRNE → "home"
  - farm / agricultural / ranch operations → "farm"
  - life-insurance / death-benefit → "life"
Pick the SINGLE closest value if signals are mixed; never invent a value outside the four. This field is INFERRED fresh from the evidence — do NOT assume any pre-existing value.

OUTPUT SHAPE (strict JSON, no prose, no markdown fence — match this EXACTLY):

{
  // ---- Top-level claim metadata (mirrors top-level claims columns) ----
  "claim_number": string|null,
  "claimant_name": string|null,
  "policy_number": string|null,
  "incident_date": string|null,         // ISO YYYY-MM-DD
  "incident_description": string|null,  // 1-3 sentences, reconciled across docs
  "accident_location": string|null,
  "claim_type": "auto"|"home"|"farm"|"life",  // inferred coverage line — see CLAIM TYPE rule above
  "demand_total": number|null,          // monetary demand if explicitly stated
  "parties": [ { "name": string, "role": string, "source_documents": [string] } ],

  // ---- Header summary card (what the UI top section binds to) ----
  "summary": string,                    // 2-4 sentence executive summary of the entire claim
  "headerInfo": {
    "claimNumber": string|null,
    "dateCompleted": string|null,       // today's ISO date — synthesis fill-in
    "completedBy": "AI Analysis & Adjuster",
    "namedobGender": string|null,       // "EVANS, CHAD | DOB 09/10/1985 | Male"
    "seatbelt": string|null,            // "Yes" / "No" / null
    "accidentLocation": string|null,
    "dateOfAccident": string|null,      // MM/DD/YYYY for display
    "accidentType": string|null,
    "attorneyRepresented": string|null, // "Yes - <firm>" / "No"
    "timeLimitDemand": string|null,
    "demandAmount": string|null         // human-formatted "$50,000" if applicable
  },

  // ---- Injuries (deduplicated across all docs) ----
  "diagnosedInjuries": [
    { "injury": string, "region": string|null, "scarringNoted": boolean|null, "pageRef": string|null }
  ],
  "priorInjuries": string|null,         // narrative summary of prior injuries

  // ---- Treatment recap (CONSOLIDATED across all docs) ----
  "treatmentRecap": {
    "narrative": string|null,           // 3-6 sentence treatment narrative across ALL docs
    "providerDetails": [                // deduplicated by provider name
      {
        "name": string,
        "specialty": string|null,
        "dateRange": string|null,
        "visits": string|null,          // total visits with this provider across all docs
        "treatmentsProvided": [string],
        "pageRefs": string|null
      }
    ],
    "imagingResults": [
      { "type": string|null, "bodyPart": string|null, "date": string|null, "findings": string|null, "pageRef": string|null }
    ],
    "prognosisAssessment": {
      "prognosis": string|null,
      "impairmentRating": string|null,
      "futureExpenses": string|null,
      "pageRef": string|null
    },
    "totalVisits": string|null,         // SUM across all providers across all docs
    "surgery": boolean,                 // TRUE if ANY doc reports surgery
    "surgeryDetails": string|null,
    "injections": boolean,              // TRUE if ANY doc reports injections
    "injectionsDetails": string|null,
    "pageRefs": string|null
  },

  // ---- Life impact + wage loss ----
  "impactToLife": string|null,
  "claimedWageLoss": string|null,

  // ---- Medical bills (deduplicated by provider+date+amount) ----
  "medicalBillBreakdown": [
    {
      "date": string|null,
      "provider": string|null,
      "complaintsOrDiagnosis": string|null,
      "type": string|null,
      "amountBilled": string|null,
      "healthInsurancePaid": string|null,
      "pageRef": string|null
    }
  ],

  // ---- Chronological recaps by provider ----
  "postAccidentRecap": [
    { "provider": string, "summary": string, "cptCodes": [string]|null, "pageRefs": string|null }
  ],
  "preAccidentRecap": [
    { "provider": string, "summary": string, "cptCodes": [string]|null, "pageRefs": string|null }
  ],

  // ---- Adjuster portion (AI drafts ALL fields except the internal-only ones) ----
  // Every dollar field MUST carry an AI-draft caveat string. Adjuster reviews + overrides.
  // currentReserves and reservesOk are STRATEGIC/INTERNAL — leave null for adjuster.
  "adjusterPortion": {
    "factsOfLoss": "1-3 sentence narrative drawn from FNOL/police_report/demand_letter/correspondence's facts_of_loss field. Pick ONE source; do NOT synthesize across. Null only if no doc has facts_of_loss.",
    "liability": {
      "draft": "1-2 sentence assessment derived from facts_of_loss + per-doc liability_signals. Null if no doc supplies fault-related language.",
      "confidence": "high|medium|low|insufficient_data",
      "caveats": ["AI draft — adjuster to verify before relying"]
    },
    "increasingFactors": {
      "narrative": "Bullet-style list of factors that push value upward — pull from impact_severity_signals + treatment_intensity_signals across docs. Examples: 'Heavy impact (vehicle totaled per FNOL p.5)', 'Ambulance transport', 'Disc herniation on MRI (Spine Correction p.12)', '3-month treatment span', 'Cervical epidural injection at C7/T1'",
      "range_low": null,
      "range_high": null,
      "caveat": "AI-suggested dollar range based on impact_severity + treatment intensity. Adjuster to confirm jurisdiction-specific anchors."
    },
    "generals": {
      "range_low": null,
      "range_high": null,
      "math": "Show the math, e.g. 'Total bills $56K × 0.15-0.30 soft-tissue+injection multiplier + heavy-impact tier 1.30 = $10,920 – $21,840'. Always show inputs.",
      "caveat": "AI draft — multipliers approximate, NOT jurisdiction-tuned; no historic settlement data factored in."
    },
    "perInjuryGenerals": [
      {
        "injury": "Cervical strain/headaches",
        "range_low": null,
        "range_high": null,
        "rationale": "Soft-tissue strain, 3-month treatment, no surgical intervention",
        "caveat": "AI draft"
      }
    ],
    "wageLoss": "Extractable state — 'None presented at this time' / '$X over N months at <employer>' / 'Pending atty response'. From per-doc claimedWageLoss reconciled across docs.",
    "medicalBillsLiens": "Total billed across all docs + lien holders + insurance offsets noted. Format like: '$56,000 total billed (Rawlings Co lien $2,957; PIP $30K + Med-Pay $5K possibly applied)'. Pull from medicalBillBreakdown + billsSummary across docs.",
    "futures": "Future-care references mentioned in records — recommended additional surgery, ongoing PT, future injections, impairment ratings translating to lifetime impact. 'None considered at this time' if no doc references future care.",
    "reductions": "Comparative negligence percentage if mentioned, PIP/Med-Pay/WC offsets, paid-by-health-insurance reductions, attorney-fee reduction context. Pull from billsSummary.insurance_offsets_noted + liability_signals.",
    "totalRange": {
      "range_low": null,
      "range_high": null,
      "math": "generals.range_low + reductions context = totalRange.range_low",
      "caveat": "AI draft; adjuster to refine with jurisdiction-specific anchors and policy-limit constraints."
    },
    "currentReserves": null,
    "reservesOk": null,
    "policyLimits": "From declarations_page OR FNOL Coverage Information block. Pull verbatim. e.g. 'BI 100/300; PD 50' or 'BI Coverage 100/300 (other coverages not stated)'."
  },

  // ---- Verification (derived from grounding outcomes across docs) ----
  "verification": {
    "status": "verified"|"needs_review"|"rejected",
    "dateAlignment": string|null,       // e.g. "DOA matches across FNOL + medical first-visit"
    "nameMatch": string|null,
    "injuryConsistency": string|null,
    "costReasonableness": string|null,
    "notes": string|null
  },

  "flags": [string],                    // deduplicated cross-doc flags
  "recommendedActions": [string],       // 3-7 substantive adjuster next-steps (see SPECIAL RULE)
  "confidence": "high"|"medium"|"low",  // top-level claim confidence
  "confidenceScore": number,            // 0-1
  "documents_summary": [                // ONE entry per source PDF
    { "file_name": string, "document_type": string, "one_line": string }
  ],
  "conflicts": [
    { "field": string, "values": [string], "chosen": string, "reason": string }
  ],

  // ---- Per-field provenance (every populated top-level field) ----
  "_provenance": {
    "<field_name>": {
      "value": <same as top-level>,
      "confidence": 0.0-1.0,
      "sources": [
        { "doc_id": string, "file_name": string, "grounding_status": string, "grounding_score": number|null, "page_ref": number|null }
      ]
    }
  }
}

The _provenance block MUST exist for every populated field. Each entry's "value" must match the top-level value. "sources" must list every doc that supplied that value. "confidence" must reflect the weighting rules.`;

// Citation hygiene. The model is instructed to cite documents by file_name in
// pageRef/pageRefs, but it occasionally leaks a doc_id UUID there (and the
// docx/UI renderers then double-wrap it into "(p. <uuid> (p. 2))"). This is a
// belt-and-suspenders pass over the parsed synthesis: in any pageRef/pageRefs
// string, swap a leaked doc_id UUID for its file_name and collapse a redundant
// inner "(p. N)" so the stored value is the canonical "<file_name> p. N".
// Scoped to pageRef keys only — _provenance doc_id fields keep their UUIDs.
const PAGE_REF_KEYS = new Set(["pageRef", "pageRefs"]);

function cleanPageRef(value: string, idToName: Map<string, string>): string {
  let s = value;
  for (const [id, name] of idToName) {
    if (id) s = s.split(id).join(name);
  }
  // "name (p. 2)" / "name (pp. 2-3)" → "name p. 2" (drop the redundant parens)
  s = s.replace(/\((pp?\.\s*[^)]*)\)/gi, "$1");
  return s.replace(/\s{2,}/g, " ").trim();
}

function normalizeCitations(node: unknown, idToName: Map<string, string>): unknown {
  if (Array.isArray(node)) return node.map((n) => normalizeCitations(n, idToName));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = PAGE_REF_KEYS.has(k) && typeof v === "string"
        ? cleanPageRef(v, idToName)
        : normalizeCitations(v, idToName);
    }
    return out;
  }
  return node;
}

const VALID_CLAIM_TYPES = new Set(["auto", "home", "farm", "life"]);

// Rebuild the user-facing "Additional Review Notes" (the `flags` array)
// deterministically. The model is unreliable at self-reporting header-field
// gaps — it has flagged "headerInfo.timeLimitDemand: not found" on claims where
// it actually populated the value — and it leaks raw field paths into the
// reviewer-facing text. So: strip the model's field-path/jargon flags, keep its
// substantive plain-English notes (e.g. "At-fault party's policy limits are not
// documented."), and recompute the four header-field gaps from the FINAL
// synthesized values, in plain English, only when genuinely missing.
function rebuildReviewNotes(synth: Record<string, unknown>): string[] {
  const h = (synth.headerInfo ?? {}) as Record<string, unknown>;
  const isBlank = (v: unknown) => {
    if (v === null || v === undefined) return true;
    const s = String(v).trim();
    return s === "" || /^(unknown|n\/?a|none|null|not specified|not found)$/i.test(s);
  };
  // Drop only flags that name a raw DB/JSON field (the jargon self-reports) —
  // keep everything else the model surfaced.
  const JARGON = /headerInfo\.|\b(timeLimitDemand|attorneyRepresented|namedobGender|dateOfBirth|demandAmount|claimNumber|dateOfAccident|accidentLocation)\b/;
  const kept = (Array.isArray(synth.flags) ? (synth.flags as unknown[]) : [])
    .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    .filter((f) => !JARGON.test(f));

  // Recompute the four header-field gaps from the final values (plain English).
  const notes: string[] = [];
  if (isBlank(h.timeLimitDemand)) {
    notes.push("No time-limit/response deadline found — confirm whether the demand letter sets one.");
  }
  if (isBlank(h.attorneyRepresented)) {
    notes.push("Attorney representation not confirmed — verify whether the claimant is represented and by which firm.");
  }
  // DOB + gender live in the combined namedobGender string ("Name | DOB <date> | <Gender>").
  const ndg = isBlank(h.namedobGender) ? "" : String(h.namedobGender);
  if (!/\bDOB\b\s*\d/i.test(ndg) && !/\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}/.test(ndg)) {
    notes.push("Claimant date of birth not found — confirm from the records.");
  }
  if (!/\b(male|female|man|woman)\b/i.test(ndg)) {
    notes.push("Claimant gender not found.");
  }
  // Code-computed gaps first, then the model's substantive notes (deduped).
  return [...new Set([...notes, ...kept])];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Scanner short-circuit. synthesize-claim-extraction is internal-only
  // (called by analyze-claim-document; verify_jwt=false). Guard prevents
  // Gemini API calls + claim mutations during scans.
  const scannerEarly = scannerShortCircuit(req, corsHeaders);
  if (scannerEarly) return scannerEarly;

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body = await req.json().catch(() => ({}));
    const claimId = body?.claimId as string | undefined;
    if (!claimId) {
      return new Response(JSON.stringify({ error: "missing_claimId" }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    await supabase
      .from("claims")
      .update({ synthesis_status: "running" })
      .eq("id", claimId);

    // Pull existing claim metadata — fields populated by the Sor
    // sync (or by an earlier synthesis) that the LLM should treat as
    // AUTHORITATIVE source-system input. Per-doc OCR/extraction can fail on
    // scanned PDFs (the BUNDY case: Declarations.pdf grounded 0.05), so
    // without this the LLM has no way to surface "BUNDY, JAMES" in the
    // synthesized output even though we already know it from the Sor
    // file header. Fetched BEFORE synthesis so it can be passed in the prompt.
    const { data: claimRow, error: claimErr } = await supabase
      .from("claims")
      .select("claim_number, claimant_name, policy_number, incident_date, incident_description, accident_location, claim_type, ai_synthesis")
      .eq("id", claimId)
      .maybeSingle();
    if (claimErr) throw claimErr;

    // Pull all completed + needs_review documents for the claim, with the
    // grounding signal and the Pass 0 classifications. Don't filter `failed`
    // docs — the prompt explicitly down-weights them; filtering would discard
    // recoverable information (a failed-grounding correspondence doc might
    // still be the only source for the claim number).
    const { data: docs, error: docsErr } = await supabase
      .from("claim_documents")
      .select("id, file_name, file_url, file_size, document_type, document_classifications, processing_status, ai_summary, ai_analysis, claim_details, extraction_completeness, grounding_status, grounding_score")
      .eq("claim_id", claimId)
      // Exclude docs soft-removed by a reconcile pass (no longer in Sor).
      .is("sor_removed_at", null)
      .in("processing_status", ["completed", "needs_review"]);
    if (docsErr) throw docsErr;

    if (!docs || docs.length === 0) {
      await supabase
        .from("claims")
        .update({ synthesis_status: "skipped", synthesized_at: new Date().toISOString() })
        .eq("id", claimId);
      return new Response(JSON.stringify({ success: true, status: "skipped", reason: "no_completed_documents" }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Build the synthesis input — compact per-doc views including the
    // grounding signal so the model can down-weight low-trust sources.
    // doc_id is preserved so the model can cite it in the _provenance block.
    const docSummaries = docs.map((d) => ({
      doc_id: d.id,
      file_name: d.file_name ?? `doc-${d.id}`,
      document_type: d.document_type ?? "unknown",
      document_classifications: d.document_classifications ?? null,
      grounding_status: d.grounding_status ?? "not_run",
      grounding_score: d.grounding_score ?? null,
      summary: d.ai_summary ?? null,
      analysis: d.ai_analysis ?? null,
      extracted_claim_details: d.claim_details ?? null,
      extraction_completeness: d.extraction_completeness ?? null,
    }));

    // Surface known claim metadata up-front. Fields here come from the
    // source system (Sor) and were either pulled at sync time or set
    // by a human in the portal. The model should treat them as authoritative
    // when per-doc extraction is silent or contradicts them.
    const knownMetadata: Record<string, string | null> = {
      claim_number: claimRow?.claim_number ?? null,
      claimant_name: claimRow?.claimant_name ?? null,
      policy_number: claimRow?.policy_number ?? null,
      // claim_type intentionally OMITTED: the stored value is an unreliable
      // DB default ('auto'). The model infers it fresh per the CLAIM TYPE rule;
      // surfacing the default here would make the model parrot it back.
      incident_date: claimRow?.incident_date ?? null,
      incident_description: claimRow?.incident_description ?? null,
      accident_location: claimRow?.accident_location ?? null,
    };
    const knownMetadataText = Object.entries(knownMetadata)
      .filter(([, v]) => v != null && String(v).trim().length > 0)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");

    const userText =
      (knownMetadataText.length > 0
        ? `=== KNOWN CLAIM METADATA from source system (Sor) ===\n` +
          `These are AUTHORITATIVE for the matching output fields. Use them to populate the ` +
          `corresponding values (claim_number, claimant_name, policy_number, incident_date, ` +
          `incident_description, accident_location, headerInfo.claimNumber, headerInfo.dateOfAccident, ` +
          `headerInfo.accidentLocation, headerInfo.namedobGender, parties[role=Insured].name). ` +
          `Per-doc analyses can still contribute OTHER fields and richer narrative, but never ` +
          `overwrite a known metadata value with null or a contradicting per-doc value.\n` +
          knownMetadataText + `\n\n`
        : "") +
      `=== DOCUMENT EXTRACTIONS (${docSummaries.length} docs) ===\n` +
      `Reconcile the following per-doc extractions into a single canonical claim view. Per-doc ` +
      `grounding signal and classifications are included — use them per the weighting rules in your ` +
      `instructions.\n\n` +
      docSummaries.map((d, idx) =>
        `--- Document ${idx + 1}: ${d.file_name} (primary=${d.document_type}, grounding=${d.grounding_status}${d.grounding_score !== null ? ` score=${(d.grounding_score * 100).toFixed(0)}%` : ''}) ---\n` +
        `doc_id: ${d.doc_id}\n` +
        (d.document_classifications ? `classifications: ${JSON.stringify(d.document_classifications)}\n` : '') +
        JSON.stringify({ summary: d.summary, extracted: d.extracted_claim_details, analysis: d.analysis }, null, 2)
      ).join("\n\n");

    // Best-effort: re-read the actual DEMAND or ATTORNEY-CORRESPONDENCE PDF so the
    // model fills attorneyRepresented (letterhead), timeLimitDemand (deadline), and
    // demandAmount straight from source — robust even if a per-doc extraction missed
    // them. Prefer a formal demand_letter; fall back to attorney correspondence
    // (where the demand lives on PIP/UIM claims with no separate demand_letter).
    // Bounded (one doc, <=12 MB) and fully wrapped so ANY failure falls back to
    // text-only synthesis (the reliable path we must not break).
    //
    // NOTE: file_url is a BARE storage path (private claim-documents bucket), so we
    // DOWNLOAD via the storage client — a plain fetch(file_url) silently fails and
    // previously disabled this entire re-read for every Sor claim.
    let demandPart: GeminiPart | null = null;
    let demandReadNote = "";
    try {
      // Cap the re-read PDF at 6 MB: attaching a ~10 MB correspondence part
      // pushed synthesis past the 150s gateway idle-timeout. Large correspondence
      // relies on per-doc extraction (which searches it page-by-page) instead.
      const cap = 6 * 1024 * 1024;
      const sized = docs.filter((d) => d.file_url && (d.file_size ?? 0) > 0 && (d.file_size ?? 0) <= cap);
      const isDemand = (d: { document_type?: string | null; document_classifications?: unknown; file_name?: string | null }) => {
        const cls = Array.isArray(d.document_classifications) ? d.document_classifications : [];
        return d.document_type === "demand_letter" ||
          cls.some((c: { type?: string }) => c?.type === "demand_letter") ||
          /\bdemand\b/.test((d.file_name ?? "").toLowerCase());
      };
      const isCorrespondence = (d: { document_type?: string | null; document_classifications?: unknown }) => {
        const cls = Array.isArray(d.document_classifications) ? d.document_classifications : [];
        return cls.some((c: { type?: string }) => c?.type === "correspondence") ||
          (d.document_type ?? "").toLowerCase().includes("correspondence");
      };
      // Demand letters: smallest first (a clean demand is short). Correspondence:
      // largest first (a demand is likelier in a substantial attorney letter).
      const demandCands = sized.filter(isDemand).sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0));
      const corrCands = sized.filter((d) => !isDemand(d) && isCorrespondence(d)).sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0));
      const candidate = demandCands[0] ?? corrCands[0];
      if (candidate?.file_url) {
        const path = storagePathFromFileUrl(String(candidate.file_url));
        const { data: blob, error: dlErr } = await supabase.storage.from("claim-documents").download(path);
        if (!dlErr && blob) {
          demandPart = { inlineData: { mimeType: "application/pdf", data: toBase64(await blob.arrayBuffer()) } };
          demandReadNote =
            `\n\n=== ATTACHED DEMAND / ATTORNEY-CORRESPONDENCE PDF (${candidate.file_name}) ===\n` +
            `Read this PDF DIRECTLY to fill headerInfo.attorneyRepresented (the law firm in the letterhead/signature, e.g. "Yes - Schneider Law"), ` +
            `headerInfo.timeLimitDemand (a CLAIMANT/attorney response or settlement deadline), and headerInfo.demandAmount (a CLAIMANT/attorney demanded settlement sum). ` +
            `A DEMAND is the CLAIMANT side demanding settlement FROM the insurer — it is NOT an insurer-originated letter (IME notice, records request, PIP/coverage denial, reservation of rights), ` +
            `NOT HIPAA "respond within N days" boilerplate, and NOT an internal reserve, PIP-paid, or medical-bill total. ` +
            `If no genuine claimant demand is present in this PDF, leave timeLimitDemand and demandAmount null. ` +
            `These take precedence over silent per-doc extractions, but NOT over the KNOWN CLAIM METADATA block above.`;
          console.log(`[synthesize-claim-extraction] re-reading ${candidate.file_name} (${(((candidate.file_size ?? 0)) / 1048576).toFixed(1)} MB) for demand/attorney fields`);
        }
      }
    } catch (e) {
      console.warn("[synthesize-claim-extraction] demand re-read skipped:", e instanceof Error ? e.message : String(e));
      demandPart = null;
      demandReadNote = "";
    }

    const synthParts: GeminiPart[] = [{ text: userText + demandReadNote }];
    if (demandPart) synthParts.push(demandPart);

    let synthesized: Record<string, unknown> | null = null;
    let synthesisError: string | null = null;
    try {
      const responseText = await generateWithInlineContent(
        synthParts,
        SYSTEM_PROMPT,
        SYNTHESIS_MODEL,
        // T=0.1 — synthesis has a small narrative component (incident_description,
        // treatmentRecap.narrative) so a sliver of variability keeps it from
        // sounding robotic. Everything else benefits from near-deterministic output.
        // 65536 output tokens: richer pre/post recaps can push past the old 32768.
        { temperature: 0.1, maxOutputTokens: 65536 },
      );
      // Strip ```json fences just in case
      const cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      synthesized = JSON.parse(cleaned);
    } catch (err) {
      synthesisError = err instanceof Error ? err.message : String(err);
      console.error("[synthesize-claim-extraction] gemini failed", synthesisError);
    }

    if (!synthesized) {
      await supabase
        .from("claims")
        .update({
          synthesis_status: "failed",
          synthesized_at: new Date().toISOString(),
          ai_synthesis: { error: synthesisError ?? "unknown" },
        })
        .eq("id", claimId);
      return new Response(JSON.stringify({ success: false, status: "failed", error: synthesisError }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Scrub any leaked doc_id UUIDs out of pageRef citations and collapse
    // double-wrapped page refs before persisting, so the docx/UI renderers
    // get the canonical "<file_name> p. N" form.
    const idToName = new Map<string, string>(
      docs.map((d) => [String(d.id), String(d.file_name ?? `doc-${d.id}`)]),
    );
    synthesized = normalizeCitations(synthesized, idToName) as Record<string, unknown>;

    // Replace the model's self-reported flags with deterministic, plain-English
    // review notes computed from the FINAL header values (no raw field paths,
    // no false "not found" on fields that were actually populated).
    synthesized.flags = rebuildReviewNotes(synthesized);

    // Reuse the claim row fetched above for the "known metadata" prompt
    // input — same fields we need to decide whether to overwrite.
    const current = claimRow;

    const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (typeof v === "string" && /^TEMP-/.test(v));

    const updates: Record<string, unknown> = {
      ai_synthesis: synthesized,
      synthesis_status: "completed",
      synthesized_at: new Date().toISOString(),
    };
    if (isEmpty(current?.claim_number) && synthesized.claim_number) updates.claim_number = synthesized.claim_number;
    if (isEmpty(current?.claimant_name) && synthesized.claimant_name) updates.claimant_name = synthesized.claimant_name;
    if (isEmpty(current?.policy_number) && synthesized.policy_number) updates.policy_number = synthesized.policy_number;
    if (isEmpty(current?.incident_date) && synthesized.incident_date && /^\d{4}-\d{2}-\d{2}$/.test(String(synthesized.incident_date))) {
      updates.incident_date = synthesized.incident_date;
    }
    if (isEmpty(current?.incident_description) && synthesized.incident_description) updates.incident_description = synthesized.incident_description;
    if (isEmpty(current?.accident_location) && synthesized.accident_location) updates.accident_location = synthesized.accident_location;
    // claim_type is special: the stored value is an unreliable DB default
    // ('auto'), so OVERWRITE it whenever the model returns a valid value
    // rather than guarding on isEmpty (the column is never empty).
    const aiClaimType = typeof synthesized.claim_type === "string"
      ? synthesized.claim_type.toLowerCase().trim()
      : null;
    if (aiClaimType && VALID_CLAIM_TYPES.has(aiClaimType)) updates.claim_type = aiClaimType;

    const { error: updateErr } = await supabase.from("claims").update(updates).eq("id", claimId);
    if (updateErr) throw updateErr;

    // Record AI changes in the field audit trail (best-effort; never break
    // synthesis). Skip the first-ever synthesis (no meaningful prior to diff).
    try {
      const prior = (current as { ai_synthesis?: unknown })?.ai_synthesis;
      if (prior && typeof prior === "object" && !Array.isArray(prior) &&
          Object.keys(prior as object).length > 0 && !(prior as { error?: unknown }).error) {
        const aiChanges = diffAnalysis(prior, synthesized);
        if (aiChanges.length > 0) {
          await supabase.from("claim_field_audit").insert(
            aiChanges.map((c) => ({
              claim_id: claimId,
              field_path: c.path,
              field_label: c.label,
              old_value: c.old ?? null,
              new_value: c.new ?? null,
              changed_by: null,
              changed_by_kind: "ai" as const,
            })),
          );
        }
      }
    } catch (e) {
      console.warn("[synthesize-claim-extraction] AI audit diff skipped:", e instanceof Error ? e.message : String(e));
    }

    // Fire-and-forget synthesis review pass — fills gaps the LLM left null
    // by lifting from per-doc analyses, plus dedupes synthesis arrays + any
    // cross-field narrative duplication. The review pass writes back to
    // claims.ai_synthesis in place; no separate status column needed.
    EdgeRuntime.waitUntil(invokeReviewSynthesis(claimId));

    return new Response(JSON.stringify({
      success: true,
      status: "completed",
      documents_considered: docs.length,
      fields_stamped: Object.keys(updates).filter((k) => k !== "ai_synthesis" && k !== "synthesis_status" && k !== "synthesized_at"),
    }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err: any) {
    console.error("synthesize-claim-extraction error:", err);
    return new Response(JSON.stringify({ error: err?.message || "internal_error" }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});

async function invokeReviewSynthesis(claimId: string): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  try {
    await fetch(`${supabaseUrl}/functions/v1/review-claim-synthesis`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ claimId }),
    });
  } catch (err) {
    console.warn(`[synthesize] review-claim-synthesis dispatch failed for ${claimId}: ${err instanceof Error ? err.message : err}`);
  }
}
