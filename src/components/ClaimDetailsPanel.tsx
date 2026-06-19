import { useState, useEffect } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { DocumentTree } from "@/components/DocumentTree";

interface ClaimContext {
  claimNumber: string;
  claimType: string;
  incidentDate: string;
  incidentDescription: string;
  claimantName: string;
  documents: Array<{
    id: string;
    fileName: string;
    documentType: string;
    fileUrl: string;
    summary?: string;
    analysis?: any;
    pageStart?: number | null;
    pageEnd?: number | null;
    resplitOf?: string | null;
    originalFileName?: string | null;
    source?: string | null;
    processingStatus?: string | null;
    sorDocumentId?: number | null;
    documentTypeCode?: string | null;
    documentDate?: string | null;
    pageCount?: number | null;
    folderName?: string | null;
    folderPath?: Array<{ id: number | null; name: string }> | null;
    pages?: Array<{ n: number | null; irPageId: number; format: string | null; rendered: boolean }> | null;
  }>;
}

interface ClaimDetailsPanelProps {
  claimContext: ClaimContext;
  onClaimContextChange: (context: ClaimContext) => void;
  isVisible: boolean;
  onToggle: () => void;
}

export function ClaimDetailsPanel({
  claimContext,
  onClaimContextChange,
  isVisible,
  onToggle,
}: ClaimDetailsPanelProps) {
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const [editedContext, setEditedContext] = useState(claimContext);
  const todayIso = new Date().toISOString().split("T")[0];

  // Editing only makes sense once a document is loaded — otherwise we'd be
  // letting users hand-type claim metadata that the AI is about to overwrite.
  const hasDocuments = claimContext.documents.length > 0;

  useEffect(() => {
    setEditedContext(claimContext);
  }, [claimContext]);

  // If the active claim changes from "has documents" to "empty" (user
  // navigates away), drop out of edit mode so we don't leave a stranded form.
  useEffect(() => {
    if (!hasDocuments && isEditing) {
      setIsEditing(false);
      setEditedContext(claimContext);
    }
  }, [hasDocuments, isEditing, claimContext]);

  const handleSave = () => {
    if (editedContext.incidentDate && editedContext.incidentDate > todayIso) {
      toast({
        title: "Invalid incident date",
        description: "Incident date can't be in the future.",
        variant: "destructive",
      });
      return;
    }
    onClaimContextChange(editedContext);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditedContext(claimContext);
    setIsEditing(false);
  };

  return (
    <>
      <button
        onClick={onToggle}
        className={cn(
          "fixed top-1/2 -translate-y-1/2 z-40 bg-surface-container-lowest border border-outline-variant border-r-0 rounded-l-lg p-2 shadow-elevation-1 hover:bg-surface-container transition-colors hidden lg:flex items-center justify-center",
          isVisible ? "right-[340px]" : "right-0",
        )}
        aria-label={isVisible ? "Hide claim details" : "Show claim details"}
      >
        <Icon name={isVisible ? "chevron_right" : "chevron_left"} size={16} />
      </button>

      <aside
        className={cn(
          "w-[340px] shrink-0 bg-surface-container-low border-l border-outline-variant overflow-y-auto scrollbar-hide hidden lg:flex flex-col transition-transform duration-300",
          isVisible ? "translate-x-0" : "translate-x-full hidden",
        )}
      >
        <div className="p-6 border-b border-outline-variant flex justify-between items-center bg-surface-container-lowest">
          <h2 className="text-headline-sm text-primary">Claim Details</h2>
          {isEditing ? (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={handleCancel}
                className="text-on-surface-variant hover:text-primary"
              >
                <Icon name="close" size={18} />
              </Button>
              <Button variant="ghost" size="icon" onClick={handleSave} className="text-success">
                <Icon name="save" size={18} />
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsEditing(true)}
              disabled={!hasDocuments}
              title={hasDocuments ? "Edit claim details" : "Upload a document first"}
              className="text-outline hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Icon name="edit" size={18} />
            </Button>
          )}
        </div>

        <div className="flex-grow overflow-y-auto scrollbar-hide p-6 space-y-8">
          {/* Claim number + claimant name now live in the top Header bar
              when Document Analyst is active; intentionally omitted here. */}
          {isEditing && (
            <div className="flex items-start gap-3">
              <Icon name="person" size={20} className="text-outline" />
              <div className="flex-grow">
                <p className="text-label-sm text-outline uppercase">Claimant Name</p>
                <Input
                  value={editedContext.claimantName}
                  onChange={(e) => setEditedContext({ ...editedContext, claimantName: e.target.value })}
                  placeholder="Enter claimant name"
                  className="mt-1"
                />
              </div>
            </div>
          )}

          {/* Metadata list */}
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <Icon name="calendar_month" size={20} className="text-outline" />
              <div className="flex-grow">
                <p className="text-label-sm text-outline uppercase">Incident Date</p>
                {isEditing ? (
                  <Input
                    type="date"
                    value={editedContext.incidentDate}
                    max={todayIso}
                    onChange={(e) => setEditedContext({ ...editedContext, incidentDate: e.target.value })}
                    className="mt-1"
                  />
                ) : (
                  <p className="text-body-md font-bold text-on-surface">
                    {claimContext.incidentDate
                      ? new Date(claimContext.incidentDate).toLocaleDateString()
                      : "—"}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Icon name="directions_car" size={20} className="text-outline" />
              <div className="flex-grow">
                <p className="text-label-sm text-outline uppercase">Claim Type</p>
                {isEditing ? (
                  <select
                    className="w-full h-10 px-3 mt-1 rounded-md border border-input bg-surface-container-lowest text-body-md"
                    value={editedContext.claimType}
                    onChange={(e) => setEditedContext({ ...editedContext, claimType: e.target.value })}
                  >
                    <option value="auto">Auto</option>
                    <option value="home">Home</option>
                    <option value="farm">Farm</option>
                    <option value="life">Life</option>
                  </select>
                ) : claimContext.claimType ? (
                  <div className="mt-1">
                    <span className="bg-primary-container text-on-primary-container text-[10px] font-bold px-2 py-0.5 rounded uppercase">
                      {claimContext.claimType}
                    </span>
                  </div>
                ) : (
                  <p className="text-body-md font-bold text-on-surface">—</p>
                )}
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Icon name="description" size={20} className="text-outline" />
              <div className="flex-grow">
                <p className="text-label-sm text-outline uppercase">Incident Description</p>
                {isEditing ? (
                  <Textarea
                    value={editedContext.incidentDescription}
                    onChange={(e) =>
                      setEditedContext({ ...editedContext, incidentDescription: e.target.value })
                    }
                    placeholder="Describe the incident..."
                    rows={4}
                    className="mt-1"
                  />
                ) : (
                  <p className="text-body-md text-on-surface mt-1">
                    {claimContext.incidentDescription || "—"}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Uploaded documents */}
          <div className="space-y-4 pt-4 border-t border-outline-variant">
            <div className="flex justify-between items-center">
              <h3 className="text-label-md text-primary uppercase tracking-widest">Uploaded Documents</h3>
              <span className="bg-surface-container-highest text-primary text-[10px] px-2 py-0.5 rounded-full font-bold">
                {claimContext.documents.length}
              </span>
            </div>

            {claimContext.documents.length === 0 ? (
              <Card className="p-4 text-center border-dashed border-outline-variant bg-surface-container-lowest rounded-xl">
                <Icon name="description" size={32} className="mx-auto text-on-surface-variant mb-2" />
                <p className="text-body-md text-on-surface-variant">No documents uploaded yet</p>
                <p className="text-xs text-on-surface-variant mt-1">
                  Use New Analysis to upload documents to analyze them
                </p>
              </Card>
            ) : (
              <DocumentTree documents={claimContext.documents} />
            )}
          </div>
        </div>

        <div className="p-6 border-t border-outline-variant bg-surface-container-low text-center">
          <p className="text-[10px] text-outline font-bold tracking-widest uppercase mb-2">
            System Status: Optimal
          </p>
          <div className="flex justify-center items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
            <span className="text-[10px] text-success font-bold">All Engines Online</span>
          </div>
        </div>
      </aside>
    </>
  );
}
