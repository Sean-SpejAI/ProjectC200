import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useProcessing, ProcessingStep } from "@/contexts/ProcessingContext";
import { useProcessingStatus } from "@/hooks/useProcessingStatus";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/Icon";

const STEPS: Array<{ id: ProcessingStep; label: string; icon: string; description: string }> = [
  { id: "uploading", label: "Upload", icon: "upload", description: "Receiving document file" },
  { id: "validating", label: "Validate", icon: "fact_check", description: "Checking file type & size (max 5MB for vision)" },
  { id: "storing", label: "Store", icon: "database", description: "Saving to secure cloud storage" },
  { id: "categorizing", label: "Categorize", icon: "folder_open", description: "Identifying document type" },
  { id: "extracting", label: "Extract", icon: "description", description: "Pulling text and embedded images" },
  { id: "analyzing", label: "Analyze", icon: "psychology", description: "AI processing with Gemini 2.5 Flash" },
  { id: "summarizing", label: "Summarize", icon: "auto_awesome", description: "Generating insights & findings" },
  { id: "saving", label: "Save", icon: "save", description: "Storing analysis results" },
];

function getStepIndex(step: ProcessingStep): number {
  const idx = STEPS.findIndex((s) => s.id === step);
  if (step === "complete") return STEPS.length;
  if (step === "error" || step === "idle") return -1;
  return idx;
}

export function ClaimsLogicDiagram() {
  const { state } = useProcessing();
  const { job, logs } = useProcessingStatus(state.documentId);

  const effectiveProgress = job?.progress ?? 0;
  const effectiveStep = job?.current_step ?? state.stepHistory[state.stepHistory.length - 1]?.message ?? "";
  const effectiveStatus =
    job?.status ??
    (state.currentStep === "complete"
      ? "completed"
      : state.currentStep === "error"
        ? "failed"
        : "pending");

  const currentIndex = getStepIndex(state.currentStep);
  const isProcessing =
    effectiveStatus === "processing" ||
    effectiveStatus === "queued" ||
    (state.currentStep !== "idle" && state.currentStep !== "complete" && state.currentStep !== "error");
  const isComplete = effectiveStatus === "completed" || state.currentStep === "complete";
  const isFailed = effectiveStatus === "failed" || state.currentStep === "error";

  const getLogIcon = (level: string) => {
    switch (level) {
      case "error":
        return "cancel";
      case "warn":
        return "warning";
      case "info":
        return "info";
      default:
        return "description";
    }
  };

  const getLogColor = (level: string) => {
    switch (level) {
      case "error":
        return "text-destructive";
      case "warn":
        return "text-warning";
      case "info":
        return "text-info";
      default:
        return "text-on-surface-variant";
    }
  };

  return (
    <div className="flex-1 p-4 md:p-6 lg:p-10 overflow-auto bg-surface">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Real-time processing status */}
        <Card
          className={cn(
            "border-2 transition-colors duration-300 rounded-2xl",
            isProcessing && "border-primary/50 shadow-elevation-1",
            isComplete && "border-success/50",
            isFailed && "border-destructive/50",
          )}
        >
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-headline-sm font-semibold flex items-center gap-2 text-primary">
                {isProcessing && <Icon name="progress_activity" size={20} className="animate-spin text-primary" />}
                {isComplete && <Icon name="check_circle" size={20} filled className="text-success" />}
                {isFailed && <Icon name="error" size={20} filled className="text-destructive" />}
                {!isProcessing && !isComplete && !isFailed && (
                  <Icon name="schedule" size={20} className="text-on-surface-variant" />
                )}
                Real-Time Processing Status
              </CardTitle>
              {(state.fileName || job) && (
                <Badge variant={isProcessing ? "default" : "secondary"} className="animate-fade-in rounded-full">
                  {state.fileName || "Processing..."}
                </Badge>
              )}
            </div>
            <div className="space-y-2">
              <p className="text-body-md text-on-surface-variant">
                {!job && state.currentStep === "idle"
                  ? "Upload a document to see live processing steps"
                  : effectiveStep}
              </p>
              {job && job.status !== "completed" && (
                <div className="flex items-center gap-3">
                  <Progress value={effectiveProgress} className="flex-1 h-2" />
                  <span className="text-xs font-mono text-on-surface-variant">{effectiveProgress}%</span>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="relative">
              <div className="absolute top-6 left-6 right-6 h-0.5 bg-outline-variant" />
              <div
                className="absolute top-6 left-6 h-0.5 bg-primary transition-all duration-500 ease-out"
                style={{
                  width: job
                    ? `${effectiveProgress}%`
                    : state.currentStep === "idle"
                      ? "0%"
                      : `${Math.min(100, ((currentIndex + 1) / STEPS.length) * 100)}%`,
                }}
              />

              <div className="relative flex justify-between">
                {STEPS.map((step, idx) => {
                  const isActive = state.currentStep === step.id;
                  const stepProgress = job ? (idx / STEPS.length) * 100 : 0;
                  const isCompleted = job
                    ? effectiveProgress > stepProgress || effectiveStatus === "completed"
                    : currentIndex > idx || state.currentStep === "complete";
                  const isPending = job
                    ? effectiveProgress <= stepProgress && effectiveStatus !== "completed"
                    : currentIndex < idx && state.currentStep !== "idle";

                  return (
                    <div
                      key={step.id}
                      className={cn(
                        "flex flex-col items-center w-20 transition-all duration-300",
                        isActive && "scale-110",
                      )}
                    >
                      <div
                        className={cn(
                          "w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 border-2",
                          isActive && "bg-primary border-primary text-primary-foreground animate-pulse",
                          isCompleted && !isActive && "bg-success border-success text-white",
                          isPending && "bg-surface-container border-outline text-on-surface-variant",
                          !isActive &&
                            !isCompleted &&
                            !isPending &&
                            "bg-surface-container-lowest border-outline text-on-surface-variant",
                        )}
                      >
                        {isCompleted && !isActive ? (
                          <Icon name="check" size={20} />
                        ) : (
                          <Icon name={step.icon} size={20} className={isActive ? "animate-bounce" : ""} />
                        )}
                      </div>
                      <span
                        className={cn(
                          "text-xs mt-2 font-semibold text-center transition-colors",
                          isActive && "text-primary",
                          isCompleted && "text-success",
                          !isActive && !isCompleted && "text-on-surface-variant",
                        )}
                      >
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {(state.stepHistory.length > 0 || logs.length > 0) && (
              <div className="mt-6 border-t border-outline-variant pt-4">
                <p className="text-label-md text-on-surface-variant uppercase tracking-widest mb-2">
                  Processing Log
                </p>
                <ScrollArea className="h-32">
                  <div className="space-y-1">
                    {logs.length > 0
                      ? logs.map((logEntry) => (
                          <div
                            key={logEntry.id}
                            className={cn(
                              "flex items-center gap-2 text-xs py-1 px-2 rounded animate-fade-in",
                              logEntry.level === "error" && "bg-destructive/10 text-destructive",
                              logEntry.level === "warn" && "bg-warning/10",
                            )}
                          >
                            <Icon
                              name={getLogIcon(logEntry.level)}
                              size={12}
                              className={getLogColor(logEntry.level)}
                            />
                            <span className="text-on-surface-variant font-mono">
                              {new Date(logEntry.created_at).toLocaleTimeString()}
                            </span>
                            <span className="font-medium">{logEntry.message}</span>
                          </div>
                        ))
                      : state.stepHistory.map((entry, idx) => (
                          <div
                            key={idx}
                            className={cn(
                              "flex items-center gap-2 text-xs py-1 px-2 rounded animate-fade-in",
                              entry.step === "error" && "bg-destructive/10 text-destructive",
                              entry.step === "complete" && "bg-success/10 text-success",
                            )}
                          >
                            <span className="text-on-surface-variant font-mono">
                              {new Date(entry.timestamp).toLocaleTimeString()}
                            </span>
                            <span className="font-medium">{entry.message}</span>
                          </div>
                        ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Static workflow documentation */}
        <Card className="rounded-2xl border-outline-variant shadow-elevation-1 bg-surface-container-lowest">
          <CardHeader>
            <CardTitle className="text-headline-sm font-semibold text-primary">
              Document Analysis Pipeline
            </CardTitle>
            <p className="text-body-md text-on-surface-variant">How documents are processed and analyzed</p>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              {STEPS.map((step, idx) => (
                <div
                  key={step.id}
                  className="flex items-start gap-3 p-3 rounded-xl bg-surface-container-low border border-outline-variant hover:bg-surface-container transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-primary-container text-on-primary-container flex items-center justify-center flex-shrink-0">
                    <Icon name={step.icon} size={16} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-on-surface-variant">Step {idx + 1}</span>
                      <span className="font-semibold text-body-md text-on-surface">{step.label}</span>
                    </div>
                    <p className="text-xs text-on-surface-variant mt-0.5">{step.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Approval workflow */}
        <Card className="rounded-2xl border-outline-variant shadow-elevation-1 bg-surface-container-lowest">
          <CardHeader>
            <CardTitle className="text-headline-sm font-semibold text-primary">Approval Workflow</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-surface-container-low border border-outline-variant rounded-xl p-4 overflow-x-auto">
              <pre className="text-xs font-mono text-on-surface-variant whitespace-pre">
{`Claim Created → Pending Queue → Reviewer Assigned → Analyze Documents
                                                          ↓
                                              ┌───────────┴───────────┐
                                              ↓                       ↓
                                         Low Risk              High Risk
                                              ↓                       ↓
                                        Auto-Route              Escalate
                                              ↓                       ↓
                                        Approve/Deny          Manager Review
                                              ↓                       ↓
                                              └───────────┬───────────┘
                                                          ↓
                                                   Completed Queue`}
              </pre>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
