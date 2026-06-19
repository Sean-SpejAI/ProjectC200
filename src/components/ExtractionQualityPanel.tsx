import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Icon } from "@/components/Icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface ExtractionQualityPanelProps {
  completeness: number;
  className?: string;
  showDetails?: boolean;
  /**
   * Optional grounding status from claim_documents.grounding_status. When set,
   * a second badge renders alongside the completeness pill showing whether
   * Claude (via Azure AI Foundry) verified the extraction against the source
   * PDF. Older docs without grounding leave this undefined.
   */
  groundingStatus?: "passed" | "partial" | "failed" | "skipped_oversize" | "not_run" | null;
}

export type GroundingStatus = NonNullable<ExtractionQualityPanelProps["groundingStatus"]>;

const GROUNDING_CONFIG: Record<GroundingStatus, {
  icon: string;
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
  description: string;
} | null> = {
  passed: {
    icon: "verified_user",
    label: "Verified",
    color: "text-success",
    bgColor: "bg-success/10",
    borderColor: "border-success/20",
    description: "Claude verified this extraction against the source PDF.",
  },
  partial: {
    icon: "warning",
    label: "Needs Review",
    color: "text-warning",
    bgColor: "bg-warning/10",
    borderColor: "border-warning/20",
    description: "Claude flagged one or more sections as weak. Human review suggested.",
  },
  failed: {
    icon: "report",
    label: "Needs Review",
    color: "text-destructive",
    bgColor: "bg-destructive/10",
    borderColor: "border-destructive/20",
    description: "Claude could not certify one or more sections after repair attempts.",
  },
  skipped_oversize: {
    icon: "block",
    label: "Skipped (too large)",
    color: "text-on-surface-variant",
    bgColor: "bg-surface-container-low",
    borderColor: "border-outline-variant",
    description: "Source PDF exceeded the grounding limit. Pass 1-4 results stand.",
  },
  // 'not_run' renders nothing — pre-grounding docs / disabled feature flag.
  not_run: null,
};

export function GroundingBadge({
  status,
  className,
}: {
  status: GroundingStatus;
  className?: string;
}) {
  const config = GROUNDING_CONFIG[status];
  if (!config) return null;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn(
              "flex items-center gap-1.5 font-medium text-xs px-2.5 py-1 rounded-full",
              config.bgColor,
              config.color,
              config.borderColor,
              className,
            )}
          >
            <Icon name={config.icon} size={14} filled />
            {config.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[250px]">
          <p className="text-xs font-medium mb-1">Grounding: {config.label}</p>
          <p className="text-xs text-on-surface-variant">{config.description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ExtractionQualityPanel({
  completeness,
  className,
  showDetails = false,
  groundingStatus,
}: ExtractionQualityPanelProps) {
  if (completeness === undefined || completeness === null) {
    return null;
  }

  const percentage = Math.round(completeness * 100);

  const getConfig = () => {
    if (percentage >= 90) {
      return {
        icon: "verified",
        label: "Excellent",
        color: "text-success",
        bgColor: "bg-success/10",
        borderColor: "border-success/20",
        description: "High quality extraction.",
      };
    }
    if (percentage >= 80) {
      return {
        icon: "verified",
        label: "Good",
        color: "text-info",
        bgColor: "bg-info/10",
        borderColor: "border-info/20",
        description: "Acceptable extraction quality.",
      };
    }
    if (percentage >= 70) {
      return {
        icon: "info",
        label: "Fair",
        color: "text-warning",
        bgColor: "bg-warning/10",
        borderColor: "border-warning/20",
        description: "Some fields may need review.",
      };
    }
    return {
      icon: "warning",
      label: "Needs Review",
      color: "text-destructive",
      bgColor: "bg-destructive/10",
      borderColor: "border-destructive/20",
      description: "Significant data gaps.",
    };
  };

  const config = getConfig();

  if (!showDetails) {
    return (
      <div className={cn("flex items-center gap-1.5", className)}>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={cn(
                  "flex items-center gap-1.5 font-medium text-xs px-2.5 py-1 rounded-full",
                  config.bgColor,
                  config.color,
                  config.borderColor,
                )}
              >
                <Icon name={config.icon} size={14} filled />
                {percentage}% complete
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[250px]">
              <p className="text-xs font-medium mb-1">Extraction Quality: {config.label}</p>
              <p className="text-xs text-on-surface-variant">{config.description}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {groundingStatus && <GroundingBadge status={groundingStatus} />}
      </div>
    );
  }

  return (
    <Card className={cn("border-2 rounded-2xl", config.borderColor, className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name={config.icon} size={20} className={config.color} filled />
            <CardTitle className="text-headline-sm text-primary">Extraction Quality</CardTitle>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge
              variant="outline"
              className={cn("font-semibold rounded-full", config.bgColor, config.color, config.borderColor)}
            >
              {config.label}
            </Badge>
            {groundingStatus && <GroundingBadge status={groundingStatus} />}
          </div>
        </div>
        <CardDescription className="text-xs mt-1">{config.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-on-surface-variant">Completeness</span>
            <span className={cn("font-semibold", config.color)}>{percentage}%</span>
          </div>
          <Progress value={percentage} className={cn("h-2", config.bgColor)} />
        </div>
      </CardContent>
    </Card>
  );
}

export function CompletenessBadge({
  completeness,
  className,
  groundingStatus,
}: {
  completeness: number;
  className?: string;
  groundingStatus?: ExtractionQualityPanelProps["groundingStatus"];
}) {
  return (
    <ExtractionQualityPanel
      completeness={completeness}
      className={className}
      showDetails={false}
      groundingStatus={groundingStatus}
    />
  );
}

export function FieldQualityBadge({
  quality,
  fieldName,
  className,
}: {
  quality: "excellent" | "good" | "poor" | "missing";
  fieldName?: string;
  className?: string;
}) {
  const getConfig = () => {
    switch (quality) {
      case "excellent":
        return {
          icon: "verified",
          label: "Excellent",
          color: "text-success",
          bgColor: "bg-success/10",
          borderColor: "border-success/20",
        };
      case "good":
        return {
          icon: "verified",
          label: "Good",
          color: "text-info",
          bgColor: "bg-info/10",
          borderColor: "border-info/20",
        };
      case "poor":
        return {
          icon: "warning",
          label: "Poor",
          color: "text-warning",
          bgColor: "bg-warning/10",
          borderColor: "border-warning/20",
        };
      case "missing":
        return {
          icon: "cancel",
          label: "Missing",
          color: "text-destructive",
          bgColor: "bg-destructive/10",
          borderColor: "border-destructive/20",
        };
    }
  };

  const config = getConfig();

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn(
              "flex items-center gap-1 font-medium text-[10px] px-1.5 py-0.5 rounded-full",
              config.bgColor,
              config.color,
              config.borderColor,
              className,
            )}
          >
            <Icon name={config.icon} size={12} filled />
            {config.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[200px]">
          {fieldName && <p className="text-xs font-medium mb-1">{fieldName}</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Pill shown on documents that are awaiting their binary content from
// ImageRight. Today this is the dominant state for IR-sourced docs because
// the spejai service account lacks View Image permission; the daily diff
// retries until content lands.
export function PendingContentBadge({ className }: { className?: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn(
              "flex items-center gap-1.5 font-medium text-xs px-2.5 py-1 rounded-full",
              "bg-surface-container-low text-on-surface-variant border-outline-variant",
              className,
            )}
          >
            <Icon name="cloud_off" size={14} />
            Awaiting ImageRight content
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px]">
          <p className="text-xs font-medium mb-1">Pending content</p>
          <p className="text-xs text-on-surface-variant">
            The document metadata has been pulled from ImageRight, but the binary file is not yet available.
            The daily diff will retry the fetch automatically.
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Claim-level badge — synthesis is the cross-document reconciliation pass.
export type SynthesisStatus = "not_run" | "pending" | "running" | "completed" | "failed" | "skipped";

export function SynthesisBadge({
  status,
  documentsConsidered,
  className,
}: {
  status: SynthesisStatus;
  documentsConsidered?: number;
  className?: string;
}) {
  if (status === "not_run" || status === "skipped") return null;
  const CONFIG: Record<SynthesisStatus, { icon: string; label: string; color: string; bg: string; border: string; desc: string }> = {
    not_run:   { icon: "schedule",     label: "—",                color: "",                       bg: "",                          border: "", desc: "" },
    skipped:   { icon: "schedule",     label: "—",                color: "",                       bg: "",                          border: "", desc: "" },
    pending:   { icon: "schedule",     label: "Synthesis queued", color: "text-on-surface-variant", bg: "bg-surface-container-low", border: "border-outline-variant", desc: "Waiting for all docs to finish per-doc analysis." },
    running:   { icon: "progress_activity", label: "Synthesizing", color: "text-info",            bg: "bg-info/10",                border: "border-info/20",        desc: "Reconciling claim-level fields across documents." },
    completed: { icon: "auto_awesome", label: documentsConsidered ? `Synthesized from ${documentsConsidered} docs` : "Synthesized", color: "text-success", bg: "bg-success/10", border: "border-success/20", desc: "Claim-level fields reconciled across all documents." },
    failed:    { icon: "report",       label: "Synthesis failed", color: "text-destructive",       bg: "bg-destructive/10",        border: "border-destructive/20", desc: "Cross-document synthesis did not complete." },
  };
  const c = CONFIG[status];
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn(
              "flex items-center gap-1.5 font-medium text-xs px-2.5 py-1 rounded-full",
              c.bg, c.color, c.border, className,
            )}
          >
            <Icon name={c.icon} size={14} filled={status === "completed"} />
            {c.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px]">
          <p className="text-xs font-medium mb-1">Cross-document synthesis</p>
          <p className="text-xs text-on-surface-variant">{c.desc}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function MultiPassStatus({
  passes,
  className,
}: {
  passes: { passNumber: number; label: string; executed: boolean; fieldsExtracted?: number }[];
  className?: string;
}) {
  return (
    <Card className={cn("border rounded-2xl", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Icon name="refresh" size={16} className="text-on-surface-variant" />
          <CardTitle className="text-sm">Multi-Pass Extraction</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {passes.map((pass) => (
            <div key={pass.passNumber} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                {pass.executed ? (
                  <Icon name="verified" size={14} filled className="text-success" />
                ) : (
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-outline" />
                )}
                <span className={cn(pass.executed ? "text-on-surface" : "text-on-surface-variant")}>
                  Pass {pass.passNumber}: {pass.label}
                </span>
              </div>
              {pass.executed && pass.fieldsExtracted !== undefined && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {pass.fieldsExtracted} fields
                </Badge>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
