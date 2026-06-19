// Pure helpers for the synthesis-review pass.
//
// All exports here are I/O-free and unit-testable. The review-claim-synthesis
// Edge Function calls these to (1) discover gaps in the LLM-synthesized
// `ai_synthesis` JSON, (2) lift values out of per-doc `ai_analysis` to fill
// them, and (3) dedupe within-array and cross-field duplication.
//
// The "why" of having this as a code-level pass (not a second LLM call) for
// the dedupe + lift portions: it's deterministic, cheap, fully auditable,
// and impossible to hallucinate.

// =====================================================================
// Types — kept loose because ai_synthesis is permissive JSON
// =====================================================================

export type AiSynthesis = Record<string, unknown> & {
  adjusterPortion?: AdjusterPortion | null;
  injuries?: unknown[];
  provider_visit_details?: unknown[];
  medicalBillBreakdown?: unknown[];
  treatmentRecap?: unknown;
  _provenance?: Record<string, ProvenanceEntry> | null;
};

export interface AdjusterPortion {
  factsOfLoss?: string | null;
  liability?: { draft?: string | null; confidence?: string | null; caveats?: string[] | null } | string | null;
  increasingFactors?: { narrative?: string | null; range_low?: number | null; range_high?: number | null; caveat?: string | null } | string | null;
  generals?: { range_low?: number | null; range_high?: number | null; math?: string | null; caveat?: string | null } | null;
  perInjuryGenerals?: Array<{ injury?: string; range_low?: number | null; range_high?: number | null; rationale?: string | null; caveat?: string | null }> | null;
  wageLoss?: string | null;
  medicalBillsLiens?: string | null;
  futures?: string | null;
  reductions?: string | null;
  totalRange?: { range_low?: number | null; range_high?: number | null; math?: string | null; caveat?: string | null } | null;
  currentReserves?: string | null;
  reservesOk?: string | null;
  policyLimits?: string | null;
}

export interface ProvenanceEntry {
  source: string;          // e.g. "synthesis" | "review_pass:doc_lift" | "review_pass:reextract:<doc_id>"
  source_doc_id?: string;  // doc_id that supplied the value
  filled_at?: string;      // ISO timestamp
}

export interface PerDocAnalysis {
  doc_id: string;
  document_type: string | null;
  ai_analysis: Record<string, unknown> | null;
}

// =====================================================================
// Gap detection
// =====================================================================

export interface GapReport {
  field: string;           // dotted path under adjusterPortion (e.g. "policyLimits", "generals.range_low")
  reason: string;          // why this is a gap (e.g. "null with declarations_page doc present")
}

const ADJUSTER_GAPS_TO_REVIEW = [
  "policyLimits",
  "factsOfLoss",
  "liability.draft",
  "generals.range_low",
  "generals.range_high",
  "medicalBillsLiens",
] as const;

export function findGaps(synthesis: AiSynthesis, docs: PerDocAnalysis[]): GapReport[] {
  const gaps: GapReport[] = [];
  const ap = synthesis.adjusterPortion ?? {};

  if (isMissingOrRefusal((ap as AdjusterPortion).policyLimits)) {
    if (docs.some((d) => looksLikeDeclarationsOrFnol(d))) {
      gaps.push({ field: "policyLimits", reason: "missing-or-refusal but FNOL/declarations_page doc present" });
    }
  }

  if (isMissingOrRefusal((ap as AdjusterPortion).factsOfLoss)) {
    if (docs.some((d) => looksLikeNarrativeSource(d))) {
      gaps.push({ field: "factsOfLoss", reason: "missing-or-refusal but narrative-source doc present" });
    }
  }

  const liability = (ap as AdjusterPortion).liability;
  const liabilityDraft = typeof liability === "string" ? liability : liability?.draft;
  if (isMissingOrRefusal(liabilityDraft)) {
    if (docs.some((d) => looksLikeNarrativeSource(d))) {
      gaps.push({ field: "liability.draft", reason: "missing-or-refusal but narrative-source doc present" });
    }
  }

  const generals = (ap as AdjusterPortion).generals;
  if (generals && (generals.range_low == null || generals.range_high == null)) {
    if (hasBills(synthesis, docs) && hasInjuries(synthesis)) {
      gaps.push({ field: "generals.range_low_or_high", reason: "null but bills + diagnosed injuries present" });
    }
  }

  if (isMissingOrRefusal((ap as AdjusterPortion).medicalBillsLiens)) {
    if (docs.some((d) => d.document_type === "bills" || d.document_type === "medical_bills")) {
      gaps.push({ field: "medicalBillsLiens", reason: "missing-or-refusal but bills doc present" });
    }
  }

  void ADJUSTER_GAPS_TO_REVIEW; // documentation reference for prioritized fields
  return gaps;
}

// =====================================================================
// Lift from per-doc analyses (no LLM call)
//
// Returns a partial `adjusterPortion` patch + provenance stamps. Fields not
// recovered are left absent — the caller should fall back to LLM re-extract.
// =====================================================================

export interface LiftResult {
  patch: Partial<AdjusterPortion>;
  provenance: Record<string, ProvenanceEntry>;
}

export function liftFromDocs(gaps: GapReport[], docs: PerDocAnalysis[]): LiftResult {
  const patch: Partial<AdjusterPortion> = {};
  const provenance: Record<string, ProvenanceEntry> = {};
  const now = new Date().toISOString();
  const stamp = (field: string, doc_id: string) => {
    provenance[`adjusterPortion.${field}`] = { source: "review_pass:doc_lift", source_doc_id: doc_id, filled_at: now };
  };

  for (const gap of gaps) {
    if (gap.field === "policyLimits") {
      const hit = findPolicyLimitsInDocs(docs);
      if (hit) {
        patch.policyLimits = hit.value;
        stamp("policyLimits", hit.docId);
      }
    } else if (gap.field === "factsOfLoss") {
      const hit = findFactsOfLossInDocs(docs);
      if (hit) {
        patch.factsOfLoss = hit.value;
        stamp("factsOfLoss", hit.docId);
      }
    } else if (gap.field === "medicalBillsLiens") {
      const hit = findMedicalBillsSummaryInDocs(docs);
      if (hit) {
        patch.medicalBillsLiens = hit.value;
        stamp("medicalBillsLiens", hit.docId);
      }
    }
    // liability.draft + generals.* require the multiplier-table reasoning;
    // a flat doc lift can't reliably produce them. Caller routes those to
    // the LLM re-extract path.
  }

  return { patch, provenance };
}

function findPolicyLimitsInDocs(docs: PerDocAnalysis[]): { value: string; docId: string } | null {
  // Priority order: declarations_page > FNOL > correspondence.
  const ordered = [...docs].sort((a, b) => priorityForPolicyLimits(b.document_type) - priorityForPolicyLimits(a.document_type));
  for (const d of ordered) {
    const a = d.ai_analysis ?? {};
    // Structured field directly off ai_analysis
    const direct = (a as Record<string, unknown>).policy_limits ?? (a as Record<string, unknown>).policyLimits;
    if (typeof direct === "string" && !isBlank(direct) && !looksLikeRefusal(direct)) {
      return { value: direct, docId: d.doc_id };
    }
    // Header info shape
    const header = (a as Record<string, unknown>).headerInfo as Record<string, unknown> | undefined;
    const fromHeader = header?.policyLimits;
    if (typeof fromHeader === "string" && !isBlank(fromHeader) && !looksLikeRefusal(fromHeader)) {
      return { value: fromHeader, docId: d.doc_id };
    }
    // Free-text regex fallback for "100/300" coverage patterns isn't wired
    // here because claim_documents doesn't carry the per-doc full text after
    // analyze runs (ai_analysis is the canonical source). If we ever store
    // full_text again, this would be the place to scan for "BI Coverage" /
    // "100/300/100" / "$100,000 / $300,000" patterns.
  }
  return null;
}

function priorityForPolicyLimits(docType: string | null): number {
  switch (docType) {
    case "declarations_page": return 3;
    case "fnol": return 2;
    case "correspondence": return 1;
    default: return 0;
  }
}

function findFactsOfLossInDocs(docs: PerDocAnalysis[]): { value: string; docId: string } | null {
  // Priority order: fnol > police_report > demand_letter > correspondence.
  const ordered = [...docs].sort((a, b) => priorityForFactsOfLoss(b.document_type) - priorityForFactsOfLoss(a.document_type));
  for (const d of ordered) {
    const a = d.ai_analysis ?? {};
    const direct = (a as Record<string, unknown>).facts_of_loss ?? (a as Record<string, unknown>).factsOfLoss;
    if (typeof direct === "string" && !isBlank(direct) && !looksLikeRefusal(direct)) {
      return { value: direct, docId: d.doc_id };
    }
  }
  return null;
}

function priorityForFactsOfLoss(docType: string | null): number {
  switch (docType) {
    case "fnol": return 4;
    case "police_report": return 3;
    case "demand_letter": return 2;
    case "correspondence": return 1;
    default: return 0;
  }
}

function findMedicalBillsSummaryInDocs(docs: PerDocAnalysis[]): { value: string; docId: string } | null {
  for (const d of docs) {
    if (d.document_type !== "bills" && d.document_type !== "medical_bills") continue;
    const a = d.ai_analysis ?? {};
    const summary = (a as Record<string, unknown>).billsSummary as Record<string, unknown> | undefined;
    const totalBilled = summary?.total_billed;
    const totalAtty = summary?.total_atty_claimed;
    if (totalBilled != null || totalAtty != null) {
      const parts: string[] = [];
      if (totalBilled != null) parts.push(`Total billed: ${totalBilled}`);
      if (totalAtty != null) parts.push(`Atty-claimed: ${totalAtty}`);
      const noted = summary?.insurance_offsets_noted;
      if (typeof noted === "string" && !isBlank(noted)) parts.push(`Offsets: ${noted}`);
      return { value: parts.join("; "), docId: d.doc_id };
    }
  }
  return null;
}

// =====================================================================
// Dedupe (c): collapse duplicate entries inside synthesis arrays
// =====================================================================

export function dedupeSynthesisArrays(s: AiSynthesis): {
  patched: AiSynthesis;
  removed: { injuries: number; provider_visit_details: number; medicalBillBreakdown: number; perInjuryGenerals: number };
} {
  const removed = { injuries: 0, provider_visit_details: 0, medicalBillBreakdown: 0, perInjuryGenerals: 0 };
  const out: AiSynthesis = { ...s };

  if (Array.isArray(s.injuries)) {
    const before = s.injuries.length;
    out.injuries = dedupeByKey(s.injuries as Record<string, unknown>[], (x) => normalize(stringify(x.injury ?? x.name)), (a, b) => preferLonger(a, b, ["description"]));
    removed.injuries = before - (out.injuries as unknown[]).length;
  }

  if (Array.isArray(s.provider_visit_details)) {
    const before = s.provider_visit_details.length;
    out.provider_visit_details = dedupeByKey(
      s.provider_visit_details as Record<string, unknown>[],
      (x) => `${normalize(stringify(x.provider))}|${normalize(stringify(x.date))}`,
      (a, b) => preferLonger(a, b, ["impressions_quoted", "plan_quoted", "exam_findings_quoted"]),
    );
    removed.provider_visit_details = before - (out.provider_visit_details as unknown[]).length;
  }

  if (Array.isArray(s.medicalBillBreakdown)) {
    const before = s.medicalBillBreakdown.length;
    out.medicalBillBreakdown = dedupeByKey(
      s.medicalBillBreakdown as Record<string, unknown>[],
      (x) => `${normalize(stringify(x.provider))}|${stringify(x.amount)}|${normalize(stringify(x.date))}`,
      (a, _b) => a,
    );
    removed.medicalBillBreakdown = before - (out.medicalBillBreakdown as unknown[]).length;
  }

  if (s.adjusterPortion && Array.isArray((s.adjusterPortion as AdjusterPortion).perInjuryGenerals)) {
    const arr = (s.adjusterPortion as AdjusterPortion).perInjuryGenerals as Array<Record<string, unknown>>;
    const before = arr.length;
    const deduped = dedupeByKey(arr, (x) => normalize(stringify(x.injury)), (a, b) => preferLonger(a, b, ["rationale", "caveat"]));
    out.adjusterPortion = { ...(s.adjusterPortion as object), perInjuryGenerals: deduped } as AdjusterPortion;
    removed.perInjuryGenerals = before - deduped.length;
  }

  return { patched: out, removed };
}

// =====================================================================
// Dedupe (d): cross-field narrative duplication
// =====================================================================

const SHARED_SUBSTRING_WORDS = 40;

export function dedupeNarrativeCrossField(s: AiSynthesis): {
  patched: AiSynthesis;
  notes: string[];
} {
  const notes: string[] = [];
  const ap = (s.adjusterPortion ?? {}) as AdjusterPortion;
  let nextAp: AdjusterPortion = { ...ap };

  const factsOfLoss = typeof ap.factsOfLoss === "string" ? ap.factsOfLoss : "";
  const increasing = ap.increasingFactors;
  const increasingNarrative = typeof increasing === "string" ? increasing : increasing?.narrative ?? "";

  if (factsOfLoss && increasingNarrative) {
    const overlap = findSharedWordRun(factsOfLoss, increasingNarrative, SHARED_SUBSTRING_WORDS);
    if (overlap) {
      const stripped = stripSentenceContaining(increasingNarrative, overlap);
      if (stripped !== increasingNarrative) {
        if (typeof increasing === "string") {
          nextAp.increasingFactors = stripped;
        } else if (increasing) {
          nextAp.increasingFactors = { ...increasing, narrative: stripped };
        }
        notes.push(`stripped ${overlap.split(/\s+/).length}-word overlap from increasingFactors.narrative`);
      }
    }
  }

  // treatmentRecap.narrative vs concatenated provider_visit_details[].plan_quoted
  const tr = s.treatmentRecap as Record<string, unknown> | string | null | undefined;
  const trNarrative = typeof tr === "string" ? tr : (tr && typeof (tr as Record<string, unknown>).narrative === "string" ? String((tr as Record<string, unknown>).narrative) : "");
  if (trNarrative && Array.isArray(s.provider_visit_details)) {
    const concatPlans = (s.provider_visit_details as Array<Record<string, unknown>>)
      .map((v) => stringify(v.plan_quoted))
      .filter(Boolean)
      .join(" ");
    if (concatPlans) {
      const overlap = findSharedWordRun(trNarrative, concatPlans, SHARED_SUBSTRING_WORDS);
      if (overlap) {
        notes.push(`treatmentRecap.narrative duplicates provider_visit_details plan quotes; left as-is (UI-rendering question, not a data correctness issue)`);
        // Not auto-stripping here — treatmentRecap is rendered separately from
        // per-visit details in the UI; the duplication is visible but not
        // wrong. Flag in notes for human review.
      }
    }
  }

  return { patched: { ...s, adjusterPortion: nextAp }, notes };
}

// =====================================================================
// Helpers
// =====================================================================

function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim().length === 0;
  return false;
}

// "Refusal text" is non-empty string content that nonetheless conveys
// "we couldn't extract this." Synthesis (and per-doc analysis) sometimes emit
// these instead of null, which silently defeats a null-only gap detector.
function looksLikeRefusal(v: string): boolean {
  return /not (?:extracted|found|present|available|provided|reported)|cannot be (?:determined|found|extracted)|unable to (?:extract|determine|find)|insufficient (?:data|information)|unreadable|failed analysis|(?:was|is) (?:unclear|unavailable|missing)|no .{0,30}(?:documents|information)|unknown\.? (?:the|a) /i.test(v);
}

// True when the field is missing (null/blank) OR present-but-refusal-text.
// Used by gap detection so a refusal-string is treated the same as null.
function isMissingOrRefusal(v: unknown): boolean {
  if (isBlank(v)) return true;
  if (typeof v === "string" && looksLikeRefusal(v)) return true;
  return false;
}

function looksLikeDeclarationsOrFnol(d: PerDocAnalysis): boolean {
  return d.document_type === "declarations_page" || d.document_type === "fnol";
}

function looksLikeNarrativeSource(d: PerDocAnalysis): boolean {
  return ["fnol", "police_report", "demand_letter", "correspondence"].includes(d.document_type ?? "");
}

function hasBills(s: AiSynthesis, _docs: PerDocAnalysis[]): boolean {
  return Array.isArray(s.medicalBillBreakdown) && s.medicalBillBreakdown.length > 0;
}

function hasInjuries(s: AiSynthesis): boolean {
  return Array.isArray(s.injuries) && s.injuries.length > 0;
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

function normalize(v: string): string {
  return v.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupeByKey<T extends Record<string, unknown>>(arr: T[], key: (x: T) => string, merge: (a: T, b: T) => T): T[] {
  const seen = new Map<string, T>();
  for (const item of arr) {
    const k = key(item);
    if (!k) {
      seen.set(`__unkeyed_${seen.size}`, item);
      continue;
    }
    const existing = seen.get(k);
    seen.set(k, existing ? merge(existing, item) : item);
  }
  return Array.from(seen.values());
}

function preferLonger<T extends Record<string, unknown>>(a: T, b: T, fields: string[]): T {
  const lenA = fields.reduce((s, f) => s + stringify(a[f]).length, 0);
  const lenB = fields.reduce((s, f) => s + stringify(b[f]).length, 0);
  return lenA >= lenB ? a : b;
}

// Returns the longest shared word-run between two strings if it's ≥ minWords.
// Word-anchored substring search — token-overlap detection, not character.
function findSharedWordRun(a: string, b: string, minWords: number): string | null {
  const wordsA = a.split(/\s+/).filter(Boolean);
  const wordsB = b.split(/\s+/).filter(Boolean);
  if (wordsA.length < minWords || wordsB.length < minWords) return null;
  for (let len = Math.min(wordsA.length, wordsB.length); len >= minWords; len--) {
    for (let i = 0; i + len <= wordsA.length; i++) {
      const candidate = wordsA.slice(i, i + len).join(" ");
      if (b.includes(candidate)) return candidate;
    }
    // Limit search depth — this is O(n²) and we only need ≥ minWords match.
    if (len === minWords) break;
  }
  return null;
}

function stripSentenceContaining(text: string, fragment: string): string {
  // Naïve sentence split; good enough for the narrative shape we produce.
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.filter((s) => !s.includes(fragment)).join(" ");
}
