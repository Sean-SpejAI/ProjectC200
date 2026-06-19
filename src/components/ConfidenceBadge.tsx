import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/Icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface ConfidenceBadgeProps {
  confidence: number | undefined;
  compact?: boolean;
  showTooltip?: boolean;
}

export function ConfidenceBadge({ confidence, compact = false, showTooltip = true }: ConfidenceBadgeProps) {
  if (confidence === undefined || confidence === null) return null;
  const percentage = Math.round(confidence * 100);

  const getConfig = () => {
    if (percentage >= 80)
      return {
        icon: "verified",
        label: "High confidence",
        className: "bg-success/10 text-success border-success/20",
        description: "AI is highly confident in this extraction. Low audit priority.",
      };
    if (percentage >= 50)
      return {
        icon: "help",
        label: "Medium confidence",
        className: "bg-warning/10 text-warning border-warning/20",
        description: "AI has moderate confidence. Consider reviewing for accuracy.",
      };
    return {
      icon: "error",
      label: "Low confidence",
      className: "bg-destructive/10 text-destructive border-destructive/20",
      description: "AI has low confidence. This section requires auditor review.",
    };
  };
  const config = getConfig();

  const badge = (
    <Badge
      variant="outline"
      className={cn(
        "inline-flex items-center gap-1 font-semibold rounded-full",
        compact ? "text-[10px] px-2 py-0.5" : "text-xs px-2.5 py-0.5",
        config.className,
      )}
    >
      <Icon name={config.icon} size={compact ? 12 : 14} filled />
      {compact ? `${percentage}%` : `${percentage}% confident`}
    </Badge>
  );

  if (!showTooltip) return badge;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-[220px]">
          <p className="text-xs font-semibold">{config.label}</p>
          <p className="text-xs text-on-surface-variant">{config.description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
