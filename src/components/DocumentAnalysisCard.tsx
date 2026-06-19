import { Icon } from "@/components/Icon";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface DocumentAnalysis {
  summary: string;
  provider?: string;
  documentDate?: string;
  patientName?: string;
  keyFindings?: string[];
  extractedData?: {
    diagnoses?: string[];
    treatments?: string[];
    medications?: string[];
    totalAmount?: string;
    itemizedCosts?: Array<{ item: string; amount: string }>;
  };
  correspondenceVerification?: {
    status: "verified" | "needs_review" | "rejected";
    dateAlignment?: string;
    nameMatch?: string;
    injuryConsistency?: string;
    notes?: string;
  };
  flags?: string[];
  recommendedActions?: string[];
  confidenceScore?: number;
}

interface DocumentAnalysisCardProps {
  analysis: DocumentAnalysis;
}

export function DocumentAnalysisCard({ analysis }: DocumentAnalysisCardProps) {
  const getStatusConfig = (status: string | undefined) => {
    switch (status) {
      case "verified":
        return { icon: "check_circle", color: "text-success", bg: "bg-success/10", label: "Verified" };
      case "rejected":
        return { icon: "cancel", color: "text-destructive", bg: "bg-destructive/10", label: "Rejected" };
      default:
        return { icon: "warning", color: "text-warning", bg: "bg-warning/10", label: "Needs Review" };
    }
  };

  const statusConfig = getStatusConfig(analysis.correspondenceVerification?.status);

  return (
    <Card className="p-6 mt-2 space-y-4 border border-outline-variant bg-surface-container-lowest shadow-elevation-1 rounded-2xl">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h4 className="text-headline-sm font-semibold text-primary mb-1">Document Analysis</h4>
          <p className="text-body-md text-on-surface-variant">{analysis.summary}</p>
        </div>
        <Badge
          variant="outline"
          className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-full", statusConfig.bg, statusConfig.color)}
        >
          <Icon name={statusConfig.icon} size={16} filled />
          {statusConfig.label}
        </Badge>
      </div>

      {(analysis.provider || analysis.documentDate || analysis.patientName) && (
        <div className="grid grid-cols-3 gap-4 text-sm">
          {analysis.provider && (
            <div>
              <span className="text-on-surface-variant flex items-center gap-1.5">
                <Icon name="description" size={14} /> Provider
              </span>
              <p className="font-medium">{analysis.provider}</p>
            </div>
          )}
          {analysis.documentDate && (
            <div>
              <span className="text-on-surface-variant flex items-center gap-1.5">
                <Icon name="calendar_today" size={14} /> Date
              </span>
              <p className="font-medium">{analysis.documentDate}</p>
            </div>
          )}
          {analysis.patientName && (
            <div>
              <span className="text-on-surface-variant flex items-center gap-1.5">
                <Icon name="person" size={14} /> Patient
              </span>
              <p className="font-medium">{analysis.patientName}</p>
            </div>
          )}
        </div>
      )}

      <Separator className="bg-outline-variant" />

      {analysis.keyFindings && analysis.keyFindings.length > 0 && (
        <div>
          <h5 className="font-semibold text-sm mb-2 flex items-center gap-2">
            <Icon name="stethoscope" size={16} className="text-secondary" filled /> Key Findings
          </h5>
          <ul className="space-y-1">
            {analysis.keyFindings.map((finding, i) => (
              <li key={i} className="text-sm text-on-surface-variant flex items-start gap-2">
                <span className="text-secondary mt-1">•</span>
                {finding}
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.extractedData && (
        <div className="grid grid-cols-2 gap-4">
          {analysis.extractedData.diagnoses && analysis.extractedData.diagnoses.length > 0 && (
            <div>
              <h5 className="font-semibold text-sm mb-2">Diagnoses</h5>
              <div className="flex flex-wrap gap-1.5">
                {analysis.extractedData.diagnoses.map((d, i) => (
                  <Badge key={i} variant="secondary" className="text-xs rounded-full">
                    {d}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {analysis.extractedData.treatments && analysis.extractedData.treatments.length > 0 && (
            <div>
              <h5 className="font-semibold text-sm mb-2">Treatments</h5>
              <div className="flex flex-wrap gap-1.5">
                {analysis.extractedData.treatments.map((t, i) => (
                  <Badge key={i} variant="outline" className="text-xs rounded-full">
                    {t}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {analysis.extractedData.medications && analysis.extractedData.medications.length > 0 && (
            <div>
              <h5 className="font-semibold text-sm mb-2 flex items-center gap-1.5">
                <Icon name="medication" size={14} /> Medications
              </h5>
              <div className="flex flex-wrap gap-1.5">
                {analysis.extractedData.medications.map((m, i) => (
                  <Badge
                    key={i}
                    variant="outline"
                    className="text-xs bg-info/10 text-info border-info/20 rounded-full"
                  >
                    {m}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {analysis.extractedData.totalAmount && (
            <div>
              <h5 className="font-semibold text-sm mb-2 flex items-center gap-1.5">
                <Icon name="attach_money" size={14} /> Total Amount
              </h5>
              <p className="text-lg font-bold text-secondary">{analysis.extractedData.totalAmount}</p>
            </div>
          )}
        </div>
      )}

      {analysis.correspondenceVerification && (
        <>
          <Separator className="bg-outline-variant" />
          <div>
            <h5 className="font-semibold text-sm mb-3">Claim Correspondence Verification</h5>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {analysis.correspondenceVerification.dateAlignment && (
                <div className="p-3 rounded-xl bg-surface-container-low border border-outline-variant">
                  <span className="text-on-surface-variant text-xs">Date Alignment</span>
                  <p className="font-medium">{analysis.correspondenceVerification.dateAlignment}</p>
                </div>
              )}
              {analysis.correspondenceVerification.nameMatch && (
                <div className="p-3 rounded-xl bg-surface-container-low border border-outline-variant">
                  <span className="text-on-surface-variant text-xs">Name Match</span>
                  <p className="font-medium">{analysis.correspondenceVerification.nameMatch}</p>
                </div>
              )}
              {analysis.correspondenceVerification.injuryConsistency && (
                <div className="p-3 rounded-xl bg-surface-container-low border border-outline-variant col-span-2">
                  <span className="text-on-surface-variant text-xs">Injury Consistency</span>
                  <p className="font-medium">{analysis.correspondenceVerification.injuryConsistency}</p>
                </div>
              )}
              {analysis.correspondenceVerification.notes && (
                <div className="p-3 rounded-xl bg-surface-container-low border border-outline-variant col-span-2">
                  <span className="text-on-surface-variant text-xs">Notes</span>
                  <p className="font-medium">{analysis.correspondenceVerification.notes}</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {analysis.flags && analysis.flags.length > 0 && (
        <>
          <Separator className="bg-outline-variant" />
          <div>
            <h5 className="font-semibold text-sm mb-2 flex items-center gap-2 text-warning">
              <Icon name="flag" size={16} filled /> Additional Review Notes
            </h5>
            <ul className="space-y-1">
              {analysis.flags.map((flag, i) => (
                <li key={i} className="text-sm text-warning flex items-start gap-2">
                  <Icon name="arrow_forward" size={14} className="mt-0.5 flex-shrink-0" />
                  {flag}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {analysis.recommendedActions && analysis.recommendedActions.length > 0 && (
        <div>
          <h5 className="font-semibold text-sm mb-2 flex items-center gap-2 text-secondary">
            <Icon name="arrow_forward" size={16} /> Recommended Actions
          </h5>
          <ul className="space-y-1">
            {analysis.recommendedActions.map((action, i) => (
              <li key={i} className="text-sm text-on-surface-variant flex items-start gap-2">
                <span className="text-secondary font-bold">{i + 1}.</span>
                {action}
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.confidenceScore !== undefined && (
        <div className="flex items-center justify-end gap-2 pt-2">
          <span className="text-xs text-on-surface-variant">Analysis Confidence:</span>
          <Badge
            variant="outline"
            className={cn(
              "text-xs rounded-full",
              analysis.confidenceScore >= 0.8
                ? "bg-success/10 text-success border-success/20"
                : analysis.confidenceScore >= 0.6
                  ? "bg-warning/10 text-warning border-warning/20"
                  : "bg-destructive/10 text-destructive border-destructive/20",
            )}
          >
            {Math.round(analysis.confidenceScore * 100)}%
          </Badge>
        </div>
      )}
    </Card>
  );
}
