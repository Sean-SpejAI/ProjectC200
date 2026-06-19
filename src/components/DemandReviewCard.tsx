import { useState, useEffect, Fragment } from "react";
import { Icon } from "@/components/Icon";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ConfidenceBadge } from "./ConfidenceBadge";
import { CompletenessBadge } from "./ExtractionQualityPanel";
import { EditableField } from "./EditableField";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { generateDemandReviewDocument, fmtPageRef } from "@/utils/generateDemandReviewDoc";
import { resolvePageCite, type CiteDoc } from "@/utils/pageCite";
import { openSignedDoc } from "@/utils/signedDocUrl";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle, XCircle } from "lucide-react";

// Helper: categorize injury text into body region
function categorizeInjuryByRegion(injury: string): string {
  const text = injury.toLowerCase();
  const regions: Array<{ name: string; keywords: string[] }> = [
    { name: 'Cervical / Neck', keywords: ['cervical', 'neck', 'c-spine', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'] },
    { name: 'Thoracic / Mid-Back', keywords: ['thoracic', 'mid back', 'mid-back', 't-spine', 'rib'] },
    { name: 'Lumbar / Low Back', keywords: ['lumbar', 'low back', 'lower back', 'l-spine', 'lumbosacral'] },
    { name: 'Head', keywords: ['head', 'headache', 'brain', 'cranial', 'concussion', 'meningioma'] },
    { name: 'Shoulder / Upper Extremity', keywords: ['shoulder', 'arm', 'elbow', 'wrist', 'hand', 'scapula', 'upper extremity'] },
    { name: 'Hip / Lower Extremity', keywords: ['hip', 'leg', 'knee', 'ankle', 'foot', 'lower extremity', 'sciatic'] },
    { name: 'Abdomen / Pelvis', keywords: ['abdomen', 'abdominal', 'pelvis', 'pelvic', 'spleen', 'liver'] },
    { name: 'Chest', keywords: ['chest', 'cardiac', 'coronary', 'aortic', 'diaphragm', 'pulmonary'] },
  ];
  for (const region of regions) {
    if (region.keywords.some(kw => text.includes(kw))) return region.name;
  }
  return 'Other';
}

// Helper: format an adjuster-portion field value for display in EditableField.
// The synthesis now emits structured objects for liability, increasingFactors,
// generals, totalRange (with range_low / range_high / math / caveat fields).
// EditableField expects a string; this collapses the object shape into a
// readable multi-line render. If the value is already a string (legacy / human
// edit), pass through unchanged. Null/undefined → empty string so the existing
// placeholder logic kicks in.
function formatAdjusterValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v !== "object") return String(v);

  const o = v as Record<string, unknown>;
  const out: string[] = [];

  // Liability object: { draft, confidence, caveats }
  if ("draft" in o || "confidence" in o) {
    const draft = o.draft;
    const conf = o.confidence;
    const caveats = o.caveats;
    if (typeof draft === "string" && draft.trim()) out.push(draft);
    if (typeof conf === "string" && conf && conf !== "high") {
      out.push(`Confidence: ${conf}`);
    }
    if (Array.isArray(caveats) && caveats.length > 0) {
      out.push(`Caveats: ${caveats.filter((c) => typeof c === "string").join("; ")}`);
    }
    return out.join("\n\n");
  }

  // Range objects: { narrative?, range_low, range_high, math?, caveat? }
  if ("range_low" in o || "range_high" in o || "math" in o || "narrative" in o) {
    const narrative = o.narrative;
    const lo = o.range_low;
    const hi = o.range_high;
    const math = o.math;
    const caveat = o.caveat;
    if (typeof narrative === "string" && narrative.trim()) out.push(narrative);
    const fmtMoney = (n: unknown) =>
      typeof n === "number" && Number.isFinite(n) ? `$${n.toLocaleString()}` : "?";
    if (lo != null || hi != null) {
      out.push(`${fmtMoney(lo)} – ${fmtMoney(hi)}`);
    }
    if (typeof math === "string" && math.trim()) out.push(`Math: ${math}`);
    if (typeof caveat === "string" && caveat.trim()) out.push(caveat);
    return out.join("\n\n");
  }

  return JSON.stringify(v);
}

// Detect whether an adjuster-portion field currently contains an AI draft
// (i.e. a structured object from synthesis) vs free-form adjuster text.
// Used to show a small "AI draft" badge next to fields that haven't been
// manually edited yet.
function isAIDraft(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "object") return true;
  return false;
}

// Helper: deduplicate narrative paragraphs.
// Guards against non-string input — some legacy ai_analysis rows store
// `treatmentRecap.narrative` as `{"treatmentRecap.narrative": null}` (an
// extraction-side bug), and `.split` on a non-string crashes the whole render.
function deduplicateNarrative(text: unknown): string {
  if (typeof text !== 'string' || !text) return '';
  const paragraphs = text.split('\n\n');
  const seen = new Set<string>();
  const unique = paragraphs.filter(p => {
    const fingerprint = p.toLowerCase().trim().slice(0, 80);
    if (!fingerprint || seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
  return unique.join('\n\n');
}

// Updated interface to match the INJURY/TREATMENT SUMMARY template exactly
interface DemandReviewAnalysis {
  summary: string;
  
  // Header Information (matching template)
  headerInfo?: {
    claimNumber?: string;
    dateCompleted?: string;
    completedBy?: string;
    namedobGender?: string;
    seatbelt?: string;
    accidentLocation?: string;
    dateOfAccident?: string;
    accidentType?: string;
    attorneyRepresented?: string;
    timeLimitDemand?: string;
    demandAmount?: string;
    confidence?: number;
  };
  
  // Diagnosed Injuries (array format)
  diagnosedInjuries?: Array<{
    injury: string;
    scarringNoted?: boolean;
    pageRef?: string;
    region?: string;
  }>;
  diagnosedInjuriesConfidence?: number;
  
  // Prior Injuries (simple text)
  priorInjuries?: string;
  priorInjuriesConfidence?: number;
  
  // Treatment Recap
  treatmentRecap?: {
    narrative?: string;
    providers?: string[]; // legacy
    providerDetails?: Array<{
      name?: string;
      specialty?: string;
      dateRange?: string;
      visits?: string;
      treatmentsProvided?: string[];
      pageRefs?: string;
    }>;
    imagingResults?: Array<{
      type?: string;
      bodyPart?: string;
      date?: string;
      findings?: string;
      pageRef?: string;
    }>;
    prognosisAssessment?: {
      prognosis?: string;
      impairmentRating?: string;
      futureExpenses?: string;
      pageRef?: string;
    };
    totalVisits?: string;
    surgery?: boolean;
    surgeryDetails?: string;
    injections?: boolean;
    injectionsDetails?: string;
    imaging?: string[]; // legacy
    pageRefs?: string;
    confidence?: number;
  };
  
  // Impact to Life (simple text)
  impactToLife?: string;
  impactToLifeConfidence?: number;
  
  // Claimed Wage Loss (simple text)
  claimedWageLoss?: string;
  claimedWageLossConfidence?: number;
  
  // Medical Bill Breakdown
  medicalBillBreakdown?: Array<{
    date?: string;
    provider?: string;
    complaintsOrDiagnosis?: string;
    type?: string;
    amountBilled?: string;
    healthInsurancePaid?: string;
    pageRef?: string;
  }>;
  medicalBillBreakdownConfidence?: number;
  
  // Post Accident Medical Record Recap by Provider
  postAccidentRecap?: Array<{
    provider: string;
    summary: string;
    cptCodes?: string[];
    pageRefs?: string;
  }>;
  postAccidentRecapConfidence?: number;
  
  // Pre-Accident Medical Record Recap by Provider
  preAccidentRecap?: Array<{
    provider: string;
    summary: string;
    cptCodes?: string[];
    pageRefs?: string;
  }>;
  preAccidentRecapConfidence?: number;
  
  // Adjuster Portion — AI drafts most fields from PDFs; adjuster overrides.
  // Each non-string field carries a `caveat` that the UI surfaces as a tooltip.
  // currentReserves and reservesOk stay manual (internal/strategic).
  adjusterPortion?: {
    factsOfLoss?: string | null;
    liability?: string | {
      draft?: string | null;
      confidence?: "high" | "medium" | "low" | "insufficient_data";
      caveats?: string[];
    } | null;
    increasingFactors?: string | {
      narrative?: string | null;
      range_low?: number | null;
      range_high?: number | null;
      caveat?: string;
    } | null;
    generals?: string | {
      range_low?: number | null;
      range_high?: number | null;
      math?: string;
      caveat?: string;
    } | null;
    perInjuryGenerals?: Array<{
      injury: string;
      range_low?: number | null;
      range_high?: number | null;
      rationale?: string;
      caveat?: string;
    }>;
    wageLoss?: string | null;
    medicalBillsLiens?: string | null;
    futures?: string | null;
    reductions?: string | null;
    totalRange?: string | {
      range_low?: number | null;
      range_high?: number | null;
      math?: string;
      caveat?: string;
    } | null;
    currentReserves?: string | null;
    reservesOk?: string | null;
    policyLimits?: string | null;
  };
  
  // Verification
  verification?: {
    status: "verified" | "needs_review" | "rejected";
    dateAlignment?: string;
    nameMatch?: string;
    injuryConsistency?: string;
    costReasonableness?: string;
    notes?: string;
    confidence?: number;
  };
  
  flags?: string[];
  recommendedActions?: string[];
  confidenceScore?: number;
  extraction_completeness?: number; // 0.0 - 1.0 score from multi-pass extraction

  // Anthropic grounding metadata (Pass 5) — populated when grounding ran.
  // status mirrors claim_documents.grounding_status; the full per-section
  // verdict tree is here for future phase 2 UI work.
  _grounding?: {
    status?: "passed" | "partial" | "failed" | "skipped_oversize" | "not_run";
    score?: number;
    iterations?: number;
    overall_verdict?: "pass" | "weak" | "fail";
    sections?: Record<string, {
      verdict: "pass" | "weak" | "fail";
      confidence: number;
      reasoning: string;
      evidence_pages?: number[] | null;
    }>;
  };
  
  // Legacy fields for backward compatibility
  demandReview?: {
    dateOfAccident?: string;
    accidentType?: string;
    attorneyRepresented?: {
      isRepresented: boolean;
      attorneyName?: string;
      lawFirm?: string;
    };
    timeLimitDemand?: string;
    demandAmount?: string;
  };
  injuries?: {
    diagnosedInjuries?: Array<{
      injury: string;
      scarringNoted?: boolean;
      severity?: string;
    }>;
    priorInjuries?: string[];
  };
  treatmentSummary?: {
    providers?: string[];
    totalVisits?: string;
    surgeryPerformed?: boolean;
    injectionsReceived?: boolean;
    imagingPerformed?: {
      performed: boolean;
      types?: string[];
    };
    treatmentNarrative?: string;
  };
  impactToLifeLegacy?: {
    dailyActivityImpact?: string;
    workImpact?: string;
    specificLimitations?: string[];
  };
  financials?: {
    claimedWageLoss?: {
      amount?: string;
      period?: string;
      employer?: string;
    };
    medicalBillBreakdown?: Array<{
      date?: string;
      provider?: string;
      complaintsOrDiagnosis?: string;
      serviceType?: string;
      amountBilled?: string;
      healthInsurancePaid?: string;
    }>;
    totalMedicalBills?: string;
    totalDemand?: string;
  };
  correspondenceVerification?: {
    status: "verified" | "needs_review" | "rejected";
    dateAlignment?: string;
    nameMatch?: string;
    injuryConsistency?: string;
    costReasonableness?: string;
    notes?: string;
  };
}

// Display-only, clickable page citation. Resolves each stored citation through
// resolvePageCite (clean "Folder › Document › p. N" text + deep-link into the
// source PDF at the right page) and renders it as a link. A single field may
// hold MULTIPLE citations joined by ";" (recaps that span several documents),
// so split and render each segment. Replaces the raw editable page-ref inputs.
function PageCite({
  pageRef,
  docs,
  className,
}: {
  pageRef?: string | null;
  docs: CiteDoc[];
  className?: string;
}) {
  const cites = String(pageRef ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((seg) => resolvePageCite(seg, docs))
    .filter((c) => c.text);
  if (cites.length === 0) return null;
  return (
    <span className={cn("text-xs text-muted-foreground", className)}>
      {cites.map((cite, idx) => (
        <Fragment key={idx}>
          {idx > 0 && "; "}
          {cite.documentId ? (
            <button
              type="button"
              onClick={() => openSignedDoc(cite.documentId!, cite.page)}
              className="underline decoration-dotted hover:text-primary cursor-pointer bg-transparent border-0 p-0 text-left text-inherit"
              title="Open the source document at this page"
            >
              {cite.text}
            </button>
          ) : (
            <span>{cite.text}</span>
          )}
        </Fragment>
      ))}
    </span>
  );
}

// One recorded change to a field (human edit or AI write), for the Audit Trail.
export interface AuditEntry {
  path: string;       // ai_synthesis dot/indexed path, e.g. "headerInfo.demandAmount"
  label: string;
  previous: unknown;  // the value BEFORE this change (old_value)
  by: string;         // resolved display name, or "AI Analysis"
  at: string;         // ISO timestamp
  kind: "human" | "ai";
}

function fmtAuditVal(v: unknown): string {
  if (v == null || v === "") return "(empty)";
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  }
  return String(v);
}

// A recap array element may legitimately be a bare string (legacy / raw model
// output that the render path explicitly handles). Normalize to an object base
// before spreading an edit, so a string isn't spread into character-index keys
// ({"0":"c","1":"h",...,"provider":value}) and corrupt the row.
function recapBase(entry: unknown): Record<string, unknown> {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) return entry as Record<string, unknown>;
  return { provider: "", summary: typeof entry === "string" ? entry : "" };
}

// Inline per-field change history shown under a field when Audit Trail is on.
// `path` matches one field exactly; `prefix` matches a whole section (e.g. all
// "medicalBillBreakdown[..]" entries) for table/array sections.
function FieldAudit({ entries, path, prefix }: { entries: AuditEntry[]; path?: string; prefix?: string }) {
  const matched = entries
    .filter((e) => (path ? e.path === path : prefix ? e.path.startsWith(prefix) : false))
    .slice(0, 7); // entries arrive newest-first
  if (matched.length === 0) return null;
  return (
    <div className="mt-1.5 border-l-2 border-amber-400/70 pl-2 space-y-1">
      <div className="text-[9px] uppercase tracking-wide text-amber-700/80 font-semibold">Change history</div>
      {matched.map((e, i) => (
        <div key={i} className="text-[10px] leading-tight text-muted-foreground">
          <span className="font-semibold text-foreground/70">{e.by}</span>
          {" · "}
          {new Date(e.at).toLocaleString()}
          {prefix && <span className="text-amber-700/80"> · {e.label}</span>}
          {" · was: "}
          <span className="italic">{fmtAuditVal(e.previous)}</span>
        </div>
      ))}
    </div>
  );
}

interface DemandReviewCardProps {
  analysis: DemandReviewAnalysis;
  claimNumber?: string;
  onAnalysisChange?: (analysis: DemandReviewAnalysis) => void;
  /** Claim documents (with fileUrl + page_start) for resolving slice-relative page citations. */
  documents?: CiteDoc[];
  /** Audit Trail mode — render each field's recent change history inline. */
  auditMode?: boolean;
  /** All audit entries for the claim (newest-first); FieldAudit filters by path/prefix. */
  auditEntries?: AuditEntry[];
}

export function DemandReviewCard({ analysis: initialAnalysis, claimNumber, onAnalysisChange, documents = [], auditMode = false, auditEntries = [] }: DemandReviewCardProps) {
  const [analysis, setAnalysis] = useState<DemandReviewAnalysis>(initialAnalysis);
  const [isGeneratingDoc, setIsGeneratingDoc] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    setAnalysis(initialAnalysis);
  }, [initialAnalysis]);

  const updateAnalysis = (updates: Partial<DemandReviewAnalysis>) => {
    const newAnalysis = { ...analysis, ...updates };
    setAnalysis(newAnalysis);
    onAnalysisChange?.(newAnalysis);
  };

  const updateHeaderInfo = (field: string, value: string) => {
    updateAnalysis({
      headerInfo: {
        ...analysis.headerInfo,
        [field]: value,
      },
    });
  };

  const updateTreatmentRecap = (field: string, value: string | boolean | string[]) => {
    updateAnalysis({
      treatmentRecap: {
        ...analysis.treatmentRecap,
        [field]: value,
      },
    });
  };

  const updateProviderDetail = (index: number, field: string, value: string | string[]) => {
    const providers = [...(analysis.treatmentRecap?.providerDetails || [])];
    providers[index] = { ...providers[index], [field]: value };
    updateAnalysis({ treatmentRecap: { ...analysis.treatmentRecap, providerDetails: providers } });
  };

  const addProviderDetail = () => {
    const providers = [...(analysis.treatmentRecap?.providerDetails || []), { name: "", specialty: "", dateRange: "", visits: "", treatmentsProvided: [], pageRefs: "" }];
    updateAnalysis({ treatmentRecap: { ...analysis.treatmentRecap, providerDetails: providers } });
  };

  const removeProviderDetail = (index: number) => {
    const providers = [...(analysis.treatmentRecap?.providerDetails || [])];
    providers.splice(index, 1);
    updateAnalysis({ treatmentRecap: { ...analysis.treatmentRecap, providerDetails: providers } });
  };

  const updateImagingResult = (index: number, field: string, value: string) => {
    const imaging = [...(analysis.treatmentRecap?.imagingResults || [])];
    imaging[index] = { ...imaging[index], [field]: value };
    updateAnalysis({ treatmentRecap: { ...analysis.treatmentRecap, imagingResults: imaging } });
  };

  const addImagingResult = () => {
    const imaging = [...(analysis.treatmentRecap?.imagingResults || []), { type: "", bodyPart: "", date: "", findings: "", pageRef: "" }];
    updateAnalysis({ treatmentRecap: { ...analysis.treatmentRecap, imagingResults: imaging } });
  };

  const removeImagingResult = (index: number) => {
    const imaging = [...(analysis.treatmentRecap?.imagingResults || [])];
    imaging.splice(index, 1);
    updateAnalysis({ treatmentRecap: { ...analysis.treatmentRecap, imagingResults: imaging } });
  };

  const updateAdjusterPortion = (field: string, value: string) => {
    updateAnalysis({
      adjusterPortion: {
        ...analysis.adjusterPortion,
        [field]: value,
      },
    });
  };

  const updateVerification = (field: string, value: string) => {
    updateAnalysis({
      verification: {
        ...analysis.verification,
        status: analysis.verification?.status || "needs_review",
        [field]: value,
      },
    });
  };

  const updateDiagnosedInjury = (index: number, value: string) => {
    const injuries = [...(analysis.diagnosedInjuries || [])];
    injuries[index] = { ...injuries[index], injury: value };
    updateAnalysis({ diagnosedInjuries: injuries });
  };

  const addDiagnosedInjury = () => {
    const injuries = [...(analysis.diagnosedInjuries || []), { injury: "" }];
    updateAnalysis({ diagnosedInjuries: injuries });
  };

  const removeDiagnosedInjury = (index: number) => {
    const injuries = [...(analysis.diagnosedInjuries || [])];
    injuries.splice(index, 1);
    updateAnalysis({ diagnosedInjuries: injuries });
  };

  const updateMedicalBill = (index: number, field: string, value: string) => {
    const bills = [...(analysis.medicalBillBreakdown || [])];
    bills[index] = { ...bills[index], [field]: value };
    updateAnalysis({ medicalBillBreakdown: bills });
  };

  const addMedicalBill = () => {
    const bills = [...(analysis.medicalBillBreakdown || []), {}];
    updateAnalysis({ medicalBillBreakdown: bills });
  };

  const removeMedicalBill = (index: number) => {
    const bills = [...(analysis.medicalBillBreakdown || [])];
    bills.splice(index, 1);
    updateAnalysis({ medicalBillBreakdown: bills });
  };

  const updatePostAccidentRecap = (index: number, field: string, value: string) => {
    const recaps = [...(analysis.postAccidentRecap || [])];
    recaps[index] = { ...recapBase(recaps[index]), [field]: value };
    updateAnalysis({ postAccidentRecap: recaps });
  };

  const addPostAccidentRecap = () => {
    const recaps = [...(analysis.postAccidentRecap || []), { provider: "", summary: "" }];
    updateAnalysis({ postAccidentRecap: recaps });
  };

  const removePostAccidentRecap = (index: number) => {
    const recaps = [...(analysis.postAccidentRecap || [])];
    recaps.splice(index, 1);
    updateAnalysis({ postAccidentRecap: recaps });
  };

  const updatePreAccidentRecap = (index: number, field: string, value: string) => {
    const recaps = [...(analysis.preAccidentRecap || [])];
    recaps[index] = { ...recapBase(recaps[index]), [field]: value };
    updateAnalysis({ preAccidentRecap: recaps });
  };

  const addPreAccidentRecap = () => {
    const recaps = [...(analysis.preAccidentRecap || []), { provider: "", summary: "" }];
    updateAnalysis({ preAccidentRecap: recaps });
  };

  const removePreAccidentRecap = (index: number) => {
    const recaps = [...(analysis.preAccidentRecap || [])];
    recaps.splice(index, 1);
    updateAnalysis({ preAccidentRecap: recaps });
  };

  const updateFlag = (index: number, value: string) => {
    const flags = [...(analysis.flags || [])];
    flags[index] = value;
    updateAnalysis({ flags });
  };

  const addFlag = () => {
    const flags = [...(analysis.flags || []), ""];
    updateAnalysis({ flags });
  };

  const removeFlag = (index: number) => {
    const flags = [...(analysis.flags || [])];
    flags.splice(index, 1);
    updateAnalysis({ flags });
  };

  const updateRecommendedAction = (index: number, value: string) => {
    const actions = [...(analysis.recommendedActions || [])];
    actions[index] = value;
    updateAnalysis({ recommendedActions: actions });
  };

  const addRecommendedAction = () => {
    const actions = [...(analysis.recommendedActions || []), ""];
    updateAnalysis({ recommendedActions: actions });
  };

  const removeRecommendedAction = (index: number) => {
    const actions = [...(analysis.recommendedActions || [])];
    actions.splice(index, 1);
    updateAnalysis({ recommendedActions: actions });
  };

  const handleDownloadDoc = async () => {
    setIsGeneratingDoc(true);
    try {
      await generateDemandReviewDocument(
        analysis,
        claimNumber || analysis.headerInfo?.claimNumber || "Unknown",
        documents
      );
      toast({
        title: "Document Generated",
        description: "The Injury/Treatment Summary has been downloaded.",
      });
    } catch (error) {
      console.error("Error generating document:", error);
      toast({
        title: "Error",
        description: "Failed to generate document. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsGeneratingDoc(false);
    }
  };

  const getStatusConfig = (status: string | undefined) => {
    switch (status) {
      case 'verified':
        return { icon: CheckCircle, color: 'text-success', bg: 'bg-success/10', label: 'Verified' };
      case 'rejected':
        return { icon: XCircle, color: 'text-destructive', bg: 'bg-destructive/10', label: 'Rejected' };
      default:
        return { icon: AlertTriangle, color: 'text-warning', bg: 'bg-warning/10', label: 'Needs Review' };
    }
  };

  // Support both new and legacy verification format
  const verificationData = analysis.verification || analysis.correspondenceVerification;
  const verificationConfidence = analysis.verification?.confidence;
  const statusConfig = getStatusConfig(verificationData?.status);
  const StatusIcon = statusConfig.icon;

  // Helper to get header info from new or legacy format
  const headerInfo = analysis.headerInfo || {
    claimNumber: analysis.demandReview?.dateOfAccident ? undefined : undefined,
    dateOfAccident: analysis.demandReview?.dateOfAccident,
    accidentType: analysis.demandReview?.accidentType,
    attorneyRepresented: analysis.demandReview?.attorneyRepresented?.isRepresented 
      ? `Yes${analysis.demandReview.attorneyRepresented.attorneyName ? ` - ${analysis.demandReview.attorneyRepresented.attorneyName}` : ''}`
      : 'No',
    timeLimitDemand: analysis.demandReview?.timeLimitDemand,
    demandAmount: analysis.demandReview?.demandAmount || analysis.financials?.totalDemand,
  };

  // Use AI-extracted diagnosed injuries data
  const diagnosedInjuries = analysis.diagnosedInjuries || [];
  
  const priorInjuries = analysis.priorInjuries || 
    (analysis.injuries?.priorInjuries?.join('; ') || '');

  // Get treatment recap from new or legacy format
  const treatmentRecap = analysis.treatmentRecap || {
    narrative: analysis.treatmentSummary?.treatmentNarrative,
    providers: analysis.treatmentSummary?.providers,
    totalVisits: analysis.treatmentSummary?.totalVisits,
    surgery: analysis.treatmentSummary?.surgeryPerformed,
    injections: analysis.treatmentSummary?.injectionsReceived,
    imaging: analysis.treatmentSummary?.imagingPerformed?.types,
  };

  // Get medical bill breakdown from new or legacy format
  const medicalBillBreakdown = analysis.medicalBillBreakdown || 
    analysis.financials?.medicalBillBreakdown?.map(b => ({
      ...b,
      type: b.serviceType,
    })) || [];

  return (
    <Card className="p-5 mt-2 space-y-5 border-2 border-border/50 bg-card/50">
      {/* Header with Title, Status, and Download Button */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <h4 className="font-bold text-lg text-foreground flex items-center gap-2">
            <Icon name="assignment" className="w-5 h-5 text-primary" />
            INJURY/TREATMENT SUMMARY
          </h4>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadDoc}
              disabled={isGeneratingDoc}
              className="flex items-center gap-1.5"
            >
              {isGeneratingDoc ? (
              <Icon name="progress_activity" className="w-4 h-4 animate-spin" />
            ) : (
              <Icon name="download" className="w-4 h-4" />
            )}
            Export .docx
          </Button>
          <Badge 
            variant="outline" 
            className={cn("flex items-center gap-1.5 px-3 py-1.5", statusConfig.bg, statusConfig.color)}
          >
              <StatusIcon className="w-4 h-4" />
              {statusConfig.label}
            </Badge>
          </div>
        </div>
        <EditableField
          value={analysis.summary}
          onSave={(value) => updateAnalysis({ summary: value })}
          className="text-sm text-muted-foreground"
          multiline
        />
      </div>

      <Separator />

      {/* Header Information Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="font-semibold text-sm flex items-center gap-2 text-primary">
            <Icon name="description" className="w-4 h-4" />
            CLAIM INFORMATION
          </h5>
          <ConfidenceBadge confidence={analysis.headerInfo?.confidence} compact />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <div className="p-3 rounded-lg bg-muted/50">
            <span className="text-muted-foreground text-xs mb-1 block">Claim Number</span>
            <EditableField
              value={headerInfo.claimNumber || ""}
              onSave={(value) => updateHeaderInfo("claimNumber", value)}
              className="font-medium"
              placeholder="Enter claim number"
            />
            {auditMode && <FieldAudit entries={auditEntries} path="headerInfo.claimNumber" />}
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <span className="text-muted-foreground text-xs mb-1 block">Date Completed</span>
            <EditableField
              value={headerInfo.dateCompleted || ""}
              onSave={(value) => updateHeaderInfo("dateCompleted", value)}
              className="font-medium"
              placeholder="Enter date"
            />
            {auditMode && <FieldAudit entries={auditEntries} path="headerInfo.dateCompleted" />}
          </div>
          <div className="p-3 rounded-lg bg-muted/50 col-span-2">
            <span className="text-muted-foreground text-xs mb-1 block">Completed By</span>
            <div className="max-h-16 overflow-y-auto">
              <p className="font-medium text-sm">
                {headerInfo.completedBy === "AI Analysis" 
                  ? "AI Analysis & Adjuster (All determinations regarding the value, reasonableness, and relatedness of medical bills and treatment are made solely by the adjuster. These considerations remain the responsibility of the adjuster and are not determined by the AI analysis tool)."
                  : headerInfo.completedBy || "AI Analysis & Adjuster"}
              </p>
            </div>
          </div>
          <div className="p-3 rounded-lg bg-muted/50 col-span-2 md:col-span-1">
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs mb-1">
              <Icon name="person" className="w-3 h-3" /> Name/DOB/Gender
            </span>
            <EditableField
              value={headerInfo.namedobGender || ""}
              onSave={(value) => updateHeaderInfo("namedobGender", value)}
              className="font-medium"
              placeholder="Enter name/DOB/gender"
            />
            {auditMode && <FieldAudit entries={auditEntries} path="headerInfo.namedobGender" />}
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <span className="text-muted-foreground text-xs mb-1 block">Seatbelt</span>
            <EditableField
              value={headerInfo.seatbelt || ""}
              onSave={(value) => updateHeaderInfo("seatbelt", value)}
              className="font-medium"
              placeholder="Yes/No"
            />
            {auditMode && <FieldAudit entries={auditEntries} path="headerInfo.seatbelt" />}
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs mb-1">
              <Icon name="location_on" className="w-3 h-3" /> Accident Location
            </span>
            <EditableField
              value={headerInfo.accidentLocation || ""}
              onSave={(value) => updateHeaderInfo("accidentLocation", value)}
              className="font-medium"
              placeholder="Enter location"
            />
            {auditMode && <FieldAudit entries={auditEntries} path="headerInfo.accidentLocation" />}
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs mb-1">
              <Icon name="calendar_today" className="w-3 h-3" /> Date of Accident
            </span>
            <EditableField
              value={headerInfo.dateOfAccident || ""}
              onSave={(value) => updateHeaderInfo("dateOfAccident", value)}
              className="font-medium"
              placeholder="Enter date"
            />
            {auditMode && <FieldAudit entries={auditEntries} path="headerInfo.dateOfAccident" />}
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs mb-1">
              <Icon name="directions_car" className="w-3 h-3" /> Accident Type
            </span>
            <EditableField
              value={headerInfo.accidentType || ""}
              onSave={(value) => updateHeaderInfo("accidentType", value)}
              className="font-medium"
              placeholder="Enter type"
            />
            {auditMode && <FieldAudit entries={auditEntries} path="headerInfo.accidentType" />}
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs mb-1">
              <Icon name="gavel" className="w-3 h-3" /> Attorney Represented
            </span>
            <EditableField
              value={headerInfo.attorneyRepresented || ""}
              onSave={(value) => updateHeaderInfo("attorneyRepresented", value)}
              className="font-medium"
              placeholder="Yes/No"
            />
            {auditMode && <FieldAudit entries={auditEntries} path="headerInfo.attorneyRepresented" />}
          </div>
          <div className="p-3 rounded-lg bg-warning/10 border border-warning/20">
            <span className="text-warning flex items-center gap-1.5 text-xs mb-1">
              <Icon name="schedule" className="w-3 h-3" /> Time Limit Demand
            </span>
            <EditableField
              value={headerInfo.timeLimitDemand || ""}
              onSave={(value) => updateHeaderInfo("timeLimitDemand", value)}
              className="font-medium text-warning"
              placeholder="Enter time limit"
            />
            {auditMode && <FieldAudit entries={auditEntries} path="headerInfo.timeLimitDemand" />}
          </div>
          <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
            <span className="text-primary flex items-center gap-1.5 text-xs mb-1">
              <Icon name="attach_money" className="w-3 h-3" /> Demand Amount
            </span>
            <EditableField
              value={headerInfo.demandAmount || ""}
              onSave={(value) => updateHeaderInfo("demandAmount", value)}
              className="font-bold text-lg text-primary"
              placeholder="$0.00"
            />
            {auditMode && <FieldAudit entries={auditEntries} path="headerInfo.demandAmount" />}
          </div>
        </div>
      </div>

      <Separator />

      {/* Adjuster Portion Section — AI-drafted (except currentReserves + reservesOk).
          Each AI-drafted field renders the synthesized text + an "AI draft" pill.
          Clicking edit replaces the AI text with the adjuster's input. */}
      <div className="space-y-4 border-[3px] border-red-500 rounded-lg p-4">
        <h5 className="font-semibold text-sm flex items-center gap-2 text-primary">
          <Icon name="assignment" className="w-4 h-4" />
          ADJUSTER PORTION
        </h5>
        <p className="text-xs text-muted-foreground -mt-2">
          AI drafts most fields from source documents. Adjuster reviews + overrides.
          Dollar ranges use generic multipliers — confirm with jurisdiction rules.
        </p>

        {(() => {
          const ap = analysis.adjusterPortion || {};
          const AiPill = ({ value }: { value: unknown }) =>
            isAIDraft(value) ? (
              <Badge variant="outline" className="ml-2 text-[10px] rounded-full bg-secondary-container text-on-secondary-container border-secondary/30">
                AI draft
              </Badge>
            ) : null;

          return (
            <>
              {/* Facts of Loss */}
              <div className="space-y-2">
                <span className="font-bold text-sm">
                  FACTS OF LOSS:<AiPill value={ap.factsOfLoss} />
                </span>
                <EditableField
                  value={formatAdjusterValue(ap.factsOfLoss)}
                  onSave={(value) => updateAdjusterPortion("factsOfLoss", value)}
                  placeholder="Click to enter facts of loss..."
                  multiline
                />
              </div>

              {/* Liability */}
              <div className="space-y-2">
                <span className="font-bold text-sm">
                  LIABILITY:<AiPill value={ap.liability} />
                </span>
                <EditableField
                  value={formatAdjusterValue(ap.liability)}
                  onSave={(value) => updateAdjusterPortion("liability", value)}
                  placeholder="Click to enter liability..."
                  multiline
                />
              </div>

              {/* Current Range of Value */}
              <div className="space-y-3">
                <span className="font-bold text-sm">CURRENT RANGE OF VALUE</span>
                <div className="space-y-2 pl-4">
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span className="font-bold text-sm min-w-[280px]">
                      INCREASING FACTORS:<AiPill value={ap.increasingFactors} />
                    </span>
                    <EditableField
                      value={formatAdjusterValue(ap.increasingFactors)}
                      onSave={(value) => updateAdjusterPortion("increasingFactors", value)}
                      placeholder="Click to enter text..."
                      multiline
                      className="flex-1"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span className="font-bold text-sm min-w-[280px]">
                      GENERALS:<AiPill value={ap.generals} />
                    </span>
                    <EditableField
                      value={formatAdjusterValue(ap.generals)}
                      onSave={(value) => updateAdjusterPortion("generals", value)}
                      placeholder="Click to enter text..."
                      multiline
                      className="flex-1"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span className="font-bold text-sm min-w-[280px]">
                      WAGE LOSS:<AiPill value={ap.wageLoss} />
                    </span>
                    <EditableField
                      value={formatAdjusterValue(ap.wageLoss)}
                      onSave={(value) => updateAdjusterPortion("wageLoss", value)}
                      placeholder="Click to enter text..."
                      className="flex-1"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span className="font-bold text-sm min-w-[280px]">
                      MEDICAL BILLS/LIENS:<AiPill value={ap.medicalBillsLiens} />
                    </span>
                    <EditableField
                      value={formatAdjusterValue(ap.medicalBillsLiens)}
                      onSave={(value) => updateAdjusterPortion("medicalBillsLiens", value)}
                      placeholder="Click to enter text..."
                      multiline
                      className="flex-1"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span className="font-bold text-sm min-w-[280px]">
                      FUTURES (MEDICAL BILLS/GENERALS):<AiPill value={ap.futures} />
                    </span>
                    <EditableField
                      value={formatAdjusterValue(ap.futures)}
                      onSave={(value) => updateAdjusterPortion("futures", value)}
                      placeholder="Click to enter text..."
                      multiline
                      className="flex-1"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span className="font-bold text-sm min-w-[280px]">
                      REDUCTIONS (COMP/NEG RANGE, OFFSETS):<AiPill value={ap.reductions} />
                    </span>
                    <EditableField
                      value={formatAdjusterValue(ap.reductions)}
                      onSave={(value) => updateAdjusterPortion("reductions", value)}
                      placeholder="Click to enter text..."
                      multiline
                      className="flex-1"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span className="font-bold text-sm min-w-[280px]">
                      TOTAL RANGE:<AiPill value={ap.totalRange} />
                    </span>
                    <EditableField
                      value={formatAdjusterValue(ap.totalRange)}
                      onSave={(value) => updateAdjusterPortion("totalRange", value)}
                      placeholder="Click to enter text..."
                      multiline
                      className="flex-1"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span className="font-bold text-sm min-w-[280px]">CURRENT RESERVES:</span>
                    <EditableField
                      value={typeof ap.currentReserves === "string" ? ap.currentReserves : ""}
                      onSave={(value) => updateAdjusterPortion("currentReserves", value)}
                      placeholder="Click to enter text..."
                      className="flex-1"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span className="font-bold text-sm min-w-[280px]">RESERVES OK?</span>
                    <EditableField
                      value={typeof ap.reservesOk === "string" ? ap.reservesOk : ""}
                      onSave={(value) => updateAdjusterPortion("reservesOk", value)}
                      placeholder="Click to enter text..."
                      className="flex-1"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="text-muted-foreground">•</span>
                    <span className="font-bold text-sm min-w-[280px]">
                      POLICY LIMITS:<AiPill value={ap.policyLimits} />
                    </span>
                    <EditableField
                      value={formatAdjusterValue(ap.policyLimits)}
                      onSave={(value) => updateAdjusterPortion("policyLimits", value)}
                      placeholder="Click to enter text..."
                      className="flex-1"
                    />
                  </div>
                </div>
              </div>
            </>
          );
        })()}
      </div>

      <Separator />

      {/* Diagnosed Injuries Section - Grouped by Body Region */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h5 className="font-semibold text-sm flex items-center gap-2 text-primary">
              <Icon name="stethoscope" className="w-4 h-4" />
              DIAGNOSED INJURIES & INJURY COMPLAINTS
            </h5>
            <p className="text-xs text-red-500 font-semibold mt-1 ml-6">Claiming <span className="font-normal italic text-muted-foreground">(As claimed in Demand Letter)</span></p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={addDiagnosedInjury} className="h-7 px-2">
              <Icon name="add" className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        <div className="space-y-3">
          {diagnosedInjuries.length > 0 ? (() => {
            // Group injuries by region
            const grouped: Record<string, Array<{ injury: any; originalIndex: number }>> = {};
            diagnosedInjuries.forEach((injury, i) => {
              const region = injury.region || categorizeInjuryByRegion(injury.injury);
              if (!grouped[region]) grouped[region] = [];
              grouped[region].push({ injury, originalIndex: i });
            });
            // Define display order
            const regionOrder = [
              'Head', 'Cervical / Neck', 'Thoracic / Mid-Back', 'Lumbar / Low Back',
              'Shoulder / Upper Extremity', 'Hip / Lower Extremity',
              'Chest', 'Abdomen / Pelvis', 'Other'
            ];
            const sortedRegions = regionOrder.filter(r => grouped[r]);
            // Add any regions not in our predefined order
            Object.keys(grouped).forEach(r => { if (!sortedRegions.includes(r)) sortedRegions.push(r); });

            return sortedRegions.map(region => (
              <div key={region} className="rounded-lg bg-muted/20 border border-border/30 p-3 space-y-1.5">
                <span className="text-xs font-bold text-primary uppercase tracking-wide">{region}</span>
                {grouped[region].map((item, regionIdx) => (
                  <div key={item.originalIndex} className="flex items-start gap-2 p-1.5 rounded bg-muted/30 group">
                    <span className="text-primary font-bold text-sm">{regionIdx + 1}.</span>
                    <div className="flex-1">
                      <EditableField
                        value={item.injury.injury}
                        onSave={(value) => updateDiagnosedInjury(item.originalIndex, value)}
                        className="text-sm font-medium"
                        placeholder="Enter injury"
                      />
                      {(() => {
                        // Show the ORIGINAL-document page (slice page_start applied),
                        // and link to the stored slice at its internal page.
                        const cite = resolvePageCite(item.injury.pageRef, documents);
                        if (!cite.text) return null;
                        return cite.documentId ? (
                          <button
                            type="button"
                            onClick={() => openSignedDoc(cite.documentId!, cite.page)}
                            className="text-xs text-muted-foreground underline decoration-dotted hover:text-primary cursor-pointer bg-transparent border-0 p-0"
                            title="Open the source document at this page"
                          >
                            ({cite.text})
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">({cite.text})</span>
                        );
                      })()}
                      {item.injury.scarringNoted && (
                        <Badge variant="outline" className="text-xs bg-destructive/10 text-destructive mt-1">
                          Scarring Noted
                        </Badge>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => removeDiagnosedInjury(item.originalIndex)}
                    >
                      <Icon name="delete" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            ));
          })() : (
            <p className="text-sm text-muted-foreground italic">Adjuster to fill out.</p>
          )}
        </div>
      </div>

      <Separator />

      {/* Prior Injuries Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="font-semibold text-sm flex items-center gap-2 text-primary">
            <Icon name="warning" className="w-4 h-4" />
            PRIOR INJURIES
          </h5>
          <ConfidenceBadge confidence={analysis.priorInjuriesConfidence} compact />
        </div>
        <div className="p-3 rounded-lg bg-warning/10 border border-warning/20">
          <EditableField
            value={priorInjuries}
            onSave={(value) => updateAnalysis({ priorInjuries: value })}
            className="text-sm"
            multiline
            placeholder="Enter prior injuries or 'None'"
          />
        </div>
      </div>

      <Separator />

      {/* Treatment Recap Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h5 className="font-semibold text-sm flex items-center gap-2 text-primary">
            <Icon name="monitor_heart" className="w-4 h-4" />
            TREATMENT RECAP
          </h5>
          <div className="flex items-center gap-2">
            {analysis.extraction_completeness !== undefined && (
              <CompletenessBadge
                completeness={analysis.extraction_completeness}
                groundingStatus={analysis._grounding?.status}
              />
            )}
            <ConfidenceBadge confidence={treatmentRecap.confidence} compact />
          </div>
        </div>

        <div className="p-3 rounded-lg bg-muted/30">
          <EditableField
            value={deduplicateNarrative(treatmentRecap.narrative || "")}
            onSave={(value) => updateTreatmentRecap("narrative", value)}
            className="text-sm"
            multiline
            placeholder="Enter treatment narrative"
          />
        </div>

        {/* Summary Stats - Stacked Vertically */}
        <div className="space-y-3">
          <Card className="p-4">
            <div className="text-sm text-muted-foreground mb-1">Total Visits</div>
            <Textarea
              value={treatmentRecap.totalVisits || ''}
              onChange={(e) => updateTreatmentRecap("totalVisits", e.target.value)}
              className="min-h-[60px]"
              placeholder="Enter total number of visits"
            />
          </Card>

          <Card className="p-4">
            <div className="text-sm text-muted-foreground mb-1">Surgery?</div>
            <div className="flex items-center space-x-2 mb-2">
              <Switch
                checked={treatmentRecap.surgery || false}
                onCheckedChange={(checked) => updateTreatmentRecap("surgery", checked)}
              />
              <span className="font-medium">{treatmentRecap.surgery ? 'Yes' : 'No'}</span>
            </div>
            <Textarea
              value={treatmentRecap.surgeryDetails || ''}
              onChange={(e) => updateTreatmentRecap("surgeryDetails", e.target.value)}
              placeholder="Surgery details if applicable..."
              className="min-h-[60px]"
            />
          </Card>

          <Card className="p-4">
            <div className="text-sm text-muted-foreground mb-1">Injections?</div>
            <div className="flex items-center space-x-2 mb-2">
              <Switch
                checked={treatmentRecap.injections || false}
                onCheckedChange={(checked) => updateTreatmentRecap("injections", checked)}
              />
              <span className="font-medium">{treatmentRecap.injections ? 'Yes' : 'No'}</span>
            </div>
            <Textarea
              value={treatmentRecap.injectionsDetails || ''}
              onChange={(e) => updateTreatmentRecap("injectionsDetails", e.target.value)}
              placeholder="Injection details if applicable..."
              className="min-h-[60px]"
            />
          </Card>
        </div>

        {/* Provider Details Grid */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Treatment by Provider</span>
              {(treatmentRecap.providerDetails && treatmentRecap.providerDetails.length > 0) && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {treatmentRecap.providerDetails.length} provider{treatmentRecap.providerDetails.length !== 1 ? 's' : ''}
                </Badge>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={addProviderDetail} className="h-7 px-2">
              <Icon name="add" className="w-3.5 h-3.5" />
            </Button>
          </div>
          {(treatmentRecap.providerDetails && treatmentRecap.providerDetails.length > 0) ? (
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="text-xs w-[180px]">Provider</TableHead>
                    <TableHead className="text-xs w-[120px]">Specialty</TableHead>
                    <TableHead className="text-xs w-[140px]">Date Range</TableHead>
                    <TableHead className="text-xs w-[60px]">Visits</TableHead>
                    <TableHead className="text-xs">Treatments Provided</TableHead>
                    <TableHead className="text-xs w-[70px]">Pages</TableHead>
                    <TableHead className="text-xs w-[40px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {treatmentRecap.providerDetails.map((provider, i) => (
                    <TableRow key={i} className="group">
                      <TableCell className="py-1.5">
                        <EditableField
                          value={provider.name || ""}
                          onSave={(value) => updateProviderDetail(i, "name", value)}
                          className="text-sm font-medium"
                          placeholder="Provider name"
                        />
                      </TableCell>
                      <TableCell className="py-1.5">
                        <EditableField
                          value={provider.specialty || ""}
                          onSave={(value) => updateProviderDetail(i, "specialty", value)}
                          className="text-xs"
                          placeholder="Specialty"
                        />
                      </TableCell>
                      <TableCell className="py-1.5">
                        <EditableField
                          value={provider.dateRange || ""}
                          onSave={(value) => updateProviderDetail(i, "dateRange", value)}
                          className="text-xs"
                          placeholder="MM/DD/YY - MM/DD/YY"
                        />
                      </TableCell>
                      <TableCell className="py-1.5">
                        <EditableField
                          value={provider.visits || ""}
                          onSave={(value) => updateProviderDetail(i, "visits", value)}
                          className="text-xs"
                          placeholder="#"
                        />
                      </TableCell>
                      <TableCell className="py-1.5">
                        <EditableField
                          value={provider.treatmentsProvided?.join(', ') || ""}
                          onSave={(value) => updateProviderDetail(i, "treatmentsProvided", value.split(',').map(s => s.trim()).filter(Boolean))}
                          className="text-xs"
                          placeholder="Treatments (comma-separated)"
                        />
                      </TableCell>
                      <TableCell className="py-1.5">
                        <PageCite pageRef={provider.pageRefs} docs={documents} />
                      </TableCell>
                      <TableCell className="py-1.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => removeProviderDetail(i)}
                        >
                          <Icon name="delete" className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic p-3 bg-muted/30 rounded-lg">No provider details. Click + to add.</p>
          )}
        </div>

        {/* Imaging Results Grid */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Imaging Results</span>
              {(treatmentRecap.imagingResults && treatmentRecap.imagingResults.length > 0) && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {treatmentRecap.imagingResults.length} stud{treatmentRecap.imagingResults.length !== 1 ? 'ies' : 'y'}
                </Badge>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={addImagingResult} className="h-7 px-2">
              <Icon name="add" className="w-3.5 h-3.5" />
            </Button>
          </div>
          {(treatmentRecap.imagingResults && treatmentRecap.imagingResults.length > 0) ? (
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="text-xs w-[100px]">Type</TableHead>
                    <TableHead className="text-xs w-[120px]">Body Part</TableHead>
                    <TableHead className="text-xs w-[100px]">Date</TableHead>
                    <TableHead className="text-xs">Findings</TableHead>
                    <TableHead className="text-xs w-[60px]">Page</TableHead>
                    <TableHead className="text-xs w-[40px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {treatmentRecap.imagingResults.map((img, i) => (
                    <TableRow key={i} className="group">
                      <TableCell className="py-1.5">
                        <EditableField
                          value={img.type || ""}
                          onSave={(value) => updateImagingResult(i, "type", value)}
                          className="text-xs font-medium"
                          placeholder="MRI/CT/X-ray"
                        />
                      </TableCell>
                      <TableCell className="py-1.5">
                        <EditableField
                          value={img.bodyPart || ""}
                          onSave={(value) => updateImagingResult(i, "bodyPart", value)}
                          className="text-xs"
                          placeholder="Body part"
                        />
                      </TableCell>
                      <TableCell className="py-1.5">
                        <EditableField
                          value={img.date || ""}
                          onSave={(value) => updateImagingResult(i, "date", value)}
                          className="text-xs"
                          placeholder="MM/DD/YYYY"
                        />
                      </TableCell>
                      <TableCell className="py-1.5">
                        <EditableField
                          value={img.findings || ""}
                          onSave={(value) => updateImagingResult(i, "findings", value)}
                          className="text-xs"
                          multiline
                          placeholder="Key findings and impression"
                        />
                      </TableCell>
                      <TableCell className="py-1.5">
                        <PageCite pageRef={img.pageRef} docs={documents} />
                      </TableCell>
                      <TableCell className="py-1.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => removeImagingResult(i)}
                        >
                          <Icon name="delete" className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic p-3 bg-muted/30 rounded-lg">No imaging results. Click + to add.</p>
          )}
        </div>

        {/* Prognosis/Assessment Section */}
        <div className="space-y-2 mt-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Prognosis/Assessment</span>
          </div>
          <Card className="p-4">
            <div className="space-y-4">
              <div>
                <Label className="text-xs text-muted-foreground">Prognosis</Label>
                <Textarea
                  value={treatmentRecap.prognosisAssessment?.prognosis || ''}
                  onChange={(e) => updateAnalysis({
                    treatmentRecap: {
                      ...analysis.treatmentRecap,
                      prognosisAssessment: {
                        ...analysis.treatmentRecap?.prognosisAssessment,
                        prognosis: e.target.value
                      }
                    }
                  })}
                  placeholder="Description of permanent injury, future treatment needs..."
                  className="min-h-[100px] mt-1"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-muted-foreground">Impairment Rating</Label>
                  <Input
                    value={treatmentRecap.prognosisAssessment?.impairmentRating || ''}
                    onChange={(e) => updateAnalysis({
                      treatmentRecap: {
                        ...analysis.treatmentRecap,
                        prognosisAssessment: {
                          ...analysis.treatmentRecap?.prognosisAssessment,
                          impairmentRating: e.target.value
                        }
                      }
                    })}
                    placeholder="e.g., 12% whole person impairment"
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground">Future Expenses</Label>
                  <Input
                    value={treatmentRecap.prognosisAssessment?.futureExpenses || ''}
                    onChange={(e) => updateAnalysis({
                      treatmentRecap: {
                        ...analysis.treatmentRecap,
                        prognosisAssessment: {
                          ...analysis.treatmentRecap?.prognosisAssessment,
                          futureExpenses: e.target.value
                        }
                      }
                    })}
                    placeholder="e.g., $2,000 annually"
                    className="mt-1"
                  />
                </div>
              </div>

              <div>
                <Label className="text-xs text-muted-foreground">Page Reference</Label>
                <div className="mt-1">
                  <PageCite pageRef={treatmentRecap.prognosisAssessment?.pageRef} docs={documents} />
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Separator />

      {/* Impact to Life Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h5 className="font-semibold text-sm flex items-center gap-2 text-primary">
              <Icon name="person" className="w-4 h-4" />
              IMPACT TO LIFE/AVERAGE DAILY ACTIVITIES
            </h5>
            <p className="text-xs italic text-muted-foreground mt-1 ml-6">(As mentioned in Demand Letter and Medical Records)</p>
          </div>
          <ConfidenceBadge confidence={analysis.impactToLifeConfidence} compact />
        </div>
        <div className="p-3 rounded-lg bg-muted/50">
          <span className="text-red-500 font-semibold text-sm">Claiming: </span>
          <EditableField
            value={analysis.impactToLife || ""}
            onSave={(value) => updateAnalysis({ impactToLife: value })}
            className="text-sm inline"
            multiline
            placeholder="Describe impact to daily activities"
          />
        </div>
      </div>

      <Separator />

      {/* Claimed Wage Loss Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="font-semibold text-sm flex items-center gap-2 text-primary">
            <Icon name="work" className="w-4 h-4" />
            CLAIMED WAGE LOSS
          </h5>
          <ConfidenceBadge confidence={analysis.claimedWageLossConfidence} compact />
        </div>
        <div className="p-3 rounded-lg bg-muted/50">
          <EditableField
            value={analysis.claimedWageLoss || ""}
            onSave={(value) => updateAnalysis({ claimedWageLoss: value })}
            className="text-sm font-medium"
            placeholder="Enter wage loss information"
          />
        </div>
      </div>

      <Separator />

      {/* Medical Bill Breakdown Table */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="font-semibold text-sm flex items-center gap-2 text-primary">
            <Icon name="attach_money" className="w-4 h-4" />
            MEDICAL BILL BREAKDOWN
          </h5>
          <div className="flex items-center gap-2">
            <ConfidenceBadge confidence={analysis.medicalBillBreakdownConfidence} compact />
            <Button variant="ghost" size="sm" onClick={addMedicalBill} className="h-7 px-2">
              <Icon name="add" className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        
        {medicalBillBreakdown.length > 0 ? (() => {
          // Helper to classify a bill as non-medical
          const isNonMedical = (bill: typeof medicalBillBreakdown[0]) => {
            const text = `${bill.provider || ''} ${bill.type || ''} ${bill.complaintsOrDiagnosis || ''}`.toLowerCase();
            return ['transportation', 'mileage', 'travel', 'parking', 'lodging', 'uber', 'lyft', 'taxi', 'gas'].some(kw => text.includes(kw));
          };

          // Helper to sanitize complaintsOrDiagnosis - remove relatedness determinations
          const sanitizeDiagnosis = (text: string | undefined) => {
            if (!text) return '';
            return text
              .replace(/all injuries related to mva/gi, '')
              .replace(/injuries related to mva/gi, '')
              .replace(/related to mva/gi, '')
              .replace(/all injuries related to accident/gi, '')
              .replace(/^\s*[,;]\s*/, '')
              .replace(/\s*[,;]\s*$/, '')
              .trim() || text;
          };

          const medicalBills = medicalBillBreakdown.map((b, i) => ({ ...b, _idx: i })).filter(b => !isNonMedical(b));
          const nonMedicalBills = medicalBillBreakdown.map((b, i) => ({ ...b, _idx: i })).filter(b => isNonMedical(b));

          // Helper to parse dollar amounts
          const parseAmount = (val: string | undefined): number => {
            if (!val) return 0;
            const num = parseFloat(val.replace(/[^0-9.-]/g, ''));
            return isNaN(num) ? 0 : num;
          };

          // Group bills by provider for subtotals
          const groupByProvider = (bills: typeof medicalBills) => {
            const groups: Record<string, typeof medicalBills> = {};
            const order: string[] = [];
            bills.forEach(b => {
              const key = b.provider || 'Unknown';
              if (!groups[key]) { groups[key] = []; order.push(key); }
              groups[key].push(b);
            });
            return { groups, order };
          };

          const formatCurrency = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

          const renderBillTable = (bills: typeof medicalBills, title: string) => {
            if (bills.length === 0) return null;
            const { groups, order } = groupByProvider(bills);
            const grandTotal = bills.reduce((sum, b) => sum + parseAmount(b.amountBilled), 0);

            return (
              <div className="space-y-2">
                <span className="text-xs font-bold text-primary uppercase tracking-wide">{title}</span>
                <div className="border rounded-lg overflow-hidden overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead className="text-xs font-semibold">Date</TableHead>
                        <TableHead className="text-xs font-semibold">Provider</TableHead>
                        <TableHead className="text-xs font-semibold">Complaints, TX, Diagnosis</TableHead>
                        <TableHead className="text-xs font-semibold">Type</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Amount Billed</TableHead>
                        <TableHead className="text-xs font-semibold text-right">Health Ins Pay?</TableHead>
                        <TableHead className="text-xs font-semibold text-center">Page</TableHead>
                        <TableHead className="w-8"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {order.map(providerName => {
                        const providerBills = groups[providerName];
                        const providerTotal = providerBills.reduce((sum, b) => sum + parseAmount(b.amountBilled), 0);
                        return (
                          <Fragment key={providerName}>
                            {providerBills.map((bill) => (
                              <TableRow key={bill._idx} className="group">
                                <TableCell className="p-1">
                                  <EditableField value={bill.date || ""} onSave={(value) => updateMedicalBill(bill._idx, "date", value)} className="text-xs" placeholder="-" />
                                </TableCell>
                                <TableCell className="p-1">
                                  <EditableField value={bill.provider || ""} onSave={(value) => updateMedicalBill(bill._idx, "provider", value)} className="text-xs font-medium" placeholder="-" />
                                </TableCell>
                                <TableCell className="p-1 max-w-[200px]">
                                  <EditableField value={sanitizeDiagnosis(bill.complaintsOrDiagnosis)} onSave={(value) => updateMedicalBill(bill._idx, "complaintsOrDiagnosis", value)} className="text-xs" placeholder="-" />
                                </TableCell>
                                <TableCell className="p-1">
                                  <EditableField value={bill.type || ""} onSave={(value) => updateMedicalBill(bill._idx, "type", value)} className="text-xs" placeholder="-" />
                                </TableCell>
                                <TableCell className="p-1 text-right">
                                  <EditableField value={bill.amountBilled || ""} onSave={(value) => updateMedicalBill(bill._idx, "amountBilled", value)} className="text-xs font-medium" placeholder="-" />
                                </TableCell>
                                <TableCell className="p-1 text-right">
                                  <EditableField value={bill.healthInsurancePaid || ""} onSave={(value) => updateMedicalBill(bill._idx, "healthInsurancePaid", value)} className="text-xs" placeholder="-" />
                                </TableCell>
                                <TableCell className="p-1 text-center">
                                  <PageCite pageRef={bill.pageRef} docs={documents} />
                                </TableCell>
                                <TableCell className="p-1">
                                  <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => removeMedicalBill(bill._idx)}>
                                    <Icon name="delete" className="h-3.5 w-3.5" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                            {/* Provider subtotal row */}
                            {providerBills.length > 1 && (
                              <TableRow className="bg-red-50 dark:bg-red-950/20">
                                <TableCell colSpan={4} className="p-1 text-right">
                                  <span className="text-xs font-bold">{providerName} Total:</span>
                                </TableCell>
                                <TableCell className="p-1 text-right">
                                  <span className="text-xs font-bold">{formatCurrency(providerTotal)}</span>
                                </TableCell>
                                <TableCell colSpan={3} className="p-1"></TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                      {/* Grand total row */}
                      <TableRow className="bg-red-100 dark:bg-red-950/40">
                        <TableCell colSpan={4} className="p-1.5 text-right">
                          <span className="text-sm font-bold">GRAND TOTAL:</span>
                        </TableCell>
                        <TableCell className="p-1.5 text-right">
                          <span className="text-sm font-bold">{formatCurrency(grandTotal)}</span>
                        </TableCell>
                        <TableCell colSpan={3} className="p-1.5"></TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </div>
            );
          };

          return (
            <div className="space-y-4">
              {renderBillTable(medicalBills, "Medical Expenses")}
              {renderBillTable(nonMedicalBills, "Non-Medical Expenses")}
            </div>
          );
        })() : (
          <p className="text-sm text-muted-foreground italic">No medical bills recorded. Click + to add.</p>
        )}
      </div>

      <Separator />

      {/* Post Accident Medical Record Recap */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="font-semibold text-sm flex items-center gap-2 text-primary">
            <Icon name="fact_check" className="w-4 h-4" />
            POST ACCIDENT MEDICAL RECORD RECAP BY PROVIDER
          </h5>
          <div className="flex items-center gap-2">
            <ConfidenceBadge confidence={analysis.postAccidentRecapConfidence} compact />
            <Button variant="ghost" size="sm" onClick={addPostAccidentRecap} className="h-7 px-2">
              <Icon name="add" className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          {(analysis.postAccidentRecap || []).map((record, i) => {
            // Defensive handling for malformed data - handle string elements gracefully
            const provider = typeof record === 'string' 
              ? 'Unknown Provider' 
              : (record?.provider || 'Unknown Provider');
            const summary = typeof record === 'string' 
              ? record 
              : (record?.summary || '');
            const pageRefs = typeof record === 'object' 
              ? (record?.pageRefs || '') 
              : '';
            const cptCodes = typeof record === 'object' && Array.isArray(record?.cptCodes)
              ? record.cptCodes
              : [];
            
            return (
              <div key={i} className="p-3 rounded-lg bg-muted/30 border-l-4 border-primary group">
                <div className="flex items-center justify-between mb-1">
                  <EditableField
                    value={provider}
                    onSave={(value) => updatePostAccidentRecap(i, "provider", value)}
                    className="text-xs font-semibold text-primary"
                    placeholder="Enter provider name"
                  />
                  <div className="flex items-center gap-2">
                    <PageCite pageRef={pageRefs} docs={documents} />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => removePostAccidentRecap(i)}
                    >
                      <Icon name="delete" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <EditableField
                  value={summary}
                  onSave={(value) => updatePostAccidentRecap(i, "summary", value)}
                  className="text-sm"
                  multiline
                  placeholder="Enter summary"
                />
                {cptCodes.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {cptCodes.map((code: string, codeIdx: number) => (
                      <span 
                        key={codeIdx} 
                        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-primary/10 text-primary border border-primary/20"
                      >
                        CPT {code}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {(!analysis.postAccidentRecap || analysis.postAccidentRecap.length === 0) && (
            <p className="text-sm text-muted-foreground italic">No records. Click + to add.</p>
          )}
        </div>
      </div>

      <Separator />

      {/* Pre-Accident Medical Record Recap */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="font-semibold text-sm flex items-center gap-2 text-primary">
            <Icon name="description" className="w-4 h-4" />
            PRE-ACCIDENT MEDICAL RECORD RECAP BY PROVIDER
          </h5>
          <div className="flex items-center gap-2">
            <ConfidenceBadge confidence={analysis.preAccidentRecapConfidence} compact />
            <Button variant="ghost" size="sm" onClick={addPreAccidentRecap} className="h-7 px-2">
              <Icon name="add" className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          {(analysis.preAccidentRecap || []).map((record, i) => {
            // Defensive handling for malformed data - handle string elements gracefully
            const provider = typeof record === 'string' 
              ? 'Pre-Accident History' 
              : (record?.provider || 'Unknown Provider');
            const summary = typeof record === 'string' 
              ? record 
              : (record?.summary || '');
            const pageRefs = typeof record === 'object' 
              ? (record?.pageRefs || '') 
              : '';
            
            return (
              <div key={i} className="p-3 rounded-lg bg-warning/5 border-l-4 border-warning group">
                <div className="flex items-center justify-between mb-1">
                  <EditableField
                    value={provider}
                    onSave={(value) => updatePreAccidentRecap(i, "provider", value)}
                    className="text-xs font-semibold text-warning"
                    placeholder="Enter provider name"
                  />
                  <div className="flex items-center gap-2">
                    <PageCite pageRef={pageRefs} docs={documents} />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => removePreAccidentRecap(i)}
                    >
                      <Icon name="delete" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <EditableField
                  value={summary}
                  onSave={(value) => updatePreAccidentRecap(i, "summary", value)}
                  className="text-sm"
                  multiline
                  placeholder="Enter summary"
                />
              </div>
            );
          })}
          {(!analysis.preAccidentRecap || analysis.preAccidentRecap.length === 0) && (
            <p className="text-sm text-muted-foreground italic">No records. Click + to add.</p>
          )}
        </div>
      </div>

      <Separator />

      {/* Verification Section */}
      {verificationData && (
        <>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h5 className="font-semibold text-sm flex items-center gap-2 text-primary">
                <Icon name="verified_user" className="w-4 h-4" />
                VERIFICATION CHECKLIST
              </h5>
              <ConfidenceBadge confidence={verificationConfidence} compact />
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <div className="p-3 rounded-lg bg-muted/50 flex items-start gap-2">
                <Icon name="calendar_today" className="w-4 h-4 text-muted-foreground mt-0.5" />
                <div className="flex-1">
                  <span className="text-muted-foreground text-xs block">Treatment Date Alignment</span>
                  <EditableField
                    value={verificationData.dateAlignment || ""}
                    onSave={(value) => updateVerification("dateAlignment", value)}
                    className="text-sm"
                    placeholder="Enter alignment notes"
                  />
                </div>
              </div>
              <div className="p-3 rounded-lg bg-muted/50 flex items-start gap-2">
                <Icon name="person" className="w-4 h-4 text-muted-foreground mt-0.5" />
                <div className="flex-1">
                  <span className="text-muted-foreground text-xs block">Name Match</span>
                  <EditableField
                    value={verificationData.nameMatch || ""}
                    onSave={(value) => updateVerification("nameMatch", value)}
                    className="text-sm"
                    placeholder="Enter name match status"
                  />
                </div>
              </div>
              <div className="p-3 rounded-lg bg-muted/50 flex items-start gap-2">
                <Icon name="stethoscope" className="w-4 h-4 text-muted-foreground mt-0.5" />
                <div className="flex-1">
                  <span className="text-muted-foreground text-xs block">Injury Consistency</span>
                  <EditableField
                    value={verificationData.injuryConsistency || ""}
                    onSave={(value) => updateVerification("injuryConsistency", value)}
                    className="text-sm"
                    placeholder="Enter consistency notes"
                  />
                </div>
              </div>
              <div className="p-3 rounded-lg bg-muted/50 flex items-start gap-2">
                <Icon name="attach_money" className="w-4 h-4 text-muted-foreground mt-0.5" />
                <div className="flex-1">
                  <span className="text-muted-foreground text-xs block">Cost Reasonableness</span>
                  <EditableField
                    value={verificationData.costReasonableness || ""}
                    onSave={(value) => updateVerification("costReasonableness", value)}
                    className="text-sm"
                    placeholder="Enter reasonableness notes"
                  />
                </div>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-muted/30">
              <span className="text-muted-foreground text-xs mb-1 block">Notes</span>
              <EditableField
                value={verificationData.notes || ""}
                onSave={(value) => updateVerification("notes", value)}
                className="text-sm"
                multiline
                placeholder="Enter verification notes"
              />
            </div>
          </div>
          <Separator />
        </>
      )}

      {/* Flags Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="font-semibold text-sm flex items-center gap-2 text-destructive">
            <Icon name="flag" className="w-4 h-4" />
            ADDITIONAL REVIEW NOTES
          </h5>
          <Button variant="ghost" size="sm" onClick={addFlag} className="h-7 px-2">
            <Icon name="add" className="w-3.5 h-3.5" />
          </Button>
        </div>
        <div className="space-y-2">
          {(analysis.flags || []).map((flag, i) => (
            <div key={i} className="flex items-start gap-2 p-2 rounded bg-destructive/10 border border-destructive/20 group">
              <Icon name="arrow_forward" className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <EditableField
                value={flag}
                onSave={(value) => updateFlag(i, value)}
                className="text-sm text-destructive flex-1"
                placeholder="Enter note"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => removeFlag(i)}
              >
                <Icon name="delete" className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {(!analysis.flags || analysis.flags.length === 0) && (
            <p className="text-sm text-muted-foreground italic">No review notes. Click + to add.</p>
          )}
        </div>
      </div>

      <Separator />

      {/* Recommended Actions Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h5 className="font-semibold text-sm flex items-center gap-2 text-primary">
            <Icon name="arrow_forward" className="w-4 h-4" />
            RECOMMENDED ACTIONS
          </h5>
          <Button variant="ghost" size="sm" onClick={addRecommendedAction} className="h-7 px-2">
            <Icon name="add" className="w-3.5 h-3.5" />
          </Button>
        </div>
        <div className="space-y-2">
          {(analysis.recommendedActions || []).map((action, i) => (
            <div key={i} className="flex items-start gap-2 p-2 rounded bg-primary/10 border border-primary/20 group">
              <Icon name="arrow_forward" className="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <EditableField
                value={action}
                onSave={(value) => updateRecommendedAction(i, value)}
                className="text-sm flex-1"
                placeholder="Enter action"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => removeRecommendedAction(i)}
              >
                <Icon name="delete" className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {(!analysis.recommendedActions || analysis.recommendedActions.length === 0) && (
            <p className="text-sm text-muted-foreground italic">No recommended actions. Click + to add.</p>
          )}
        </div>
      </div>

      <Separator />

      {/* Confidence Score */}
      {analysis.confidenceScore !== undefined && (
        <div className="flex justify-end">
          <Badge 
            variant="outline" 
            className={cn(
              "px-3 py-1.5",
              analysis.confidenceScore >= 0.8 ? "bg-success/10 text-success border-success/20" :
              analysis.confidenceScore >= 0.5 ? "bg-warning/10 text-warning border-warning/20" :
              "bg-destructive/10 text-destructive border-destructive/20"
            )}
          >
            Confidence: {Math.round(analysis.confidenceScore * 100)}%
          </Badge>
        </div>
      )}

      {/* Audit Trail — change history for every NON-header field (the header
          fields show their history inline above). Grouped by field, last 7 each,
          newest first. Shown only in Audit Trail mode. */}
      {auditMode && (() => {
        const others = auditEntries.filter((e) => !e.path.startsWith("headerInfo."));
        if (others.length === 0) return null;
        const byPath = new Map<string, AuditEntry[]>();
        for (const e of others) {
          const arr = byPath.get(e.path) ?? [];
          if (arr.length < 7) arr.push(e); // entries are newest-first
          byPath.set(e.path, arr);
        }
        return (
          <>
            <Separator />
            <div className="space-y-3">
              <h5 className="font-semibold text-sm flex items-center gap-2 text-amber-700">
                <Icon name="history" className="w-4 h-4" />
                FIELD CHANGE HISTORY (last 7 per field)
              </h5>
              <div className="space-y-2">
                {[...byPath.entries()].map(([path, entries]) => (
                  <div key={path} className="border-l-2 border-amber-400/70 pl-2">
                    <div className="text-xs font-semibold text-foreground/80">{entries[0].label}</div>
                    {entries.map((e, i) => (
                      <div key={i} className="text-[10px] leading-tight text-muted-foreground">
                        <span className="font-semibold text-foreground/70">{e.by}</span>
                        {" · "}{new Date(e.at).toLocaleString()}{" · was: "}
                        <span className="italic">{fmtAuditVal(e.previous)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </>
        );
      })()}
    </Card>
  );
}
