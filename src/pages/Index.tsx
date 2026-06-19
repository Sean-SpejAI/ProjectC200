import { useState } from "react";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { Icon } from "@/components/Icon";
import { ClaimsAgent } from "@/components/ClaimsAgent";
import { ClaimDetailsPanel } from "@/components/ClaimDetailsPanel";
import { ClaimsQueue } from "@/components/ClaimsQueue";
import { NewAnalysisUpload } from "@/components/NewAnalysisUpload";
import { ClaimsLogicDiagram } from "@/components/ClaimsLogicDiagram";
import { HeaderClaimSearch } from "@/components/HeaderClaimSearch";
import { ProcessingProvider } from "@/contexts/ProcessingContext";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface ClaimContext {
  id?: string;
  source?: "manual" | "sor";
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
    /** Original-doc page where this slice starts (claim_details.page_start); null for non-split. */
    pageStart?: number | null;
    pageEnd?: number | null;
    resplitOf?: string | null;
    originalFileName?: string | null;
    source?: string | null;
    processingStatus?: string | null;
    // Sor hierarchy (null for manual uploads) — powers the document tree + citations.
    sorDocumentId?: number | null;
    documentTypeCode?: string | null;
    documentDate?: string | null;
    pageCount?: number | null;
    folderName?: string | null;
    folderPath?: Array<{ id: number | null; name: string }> | null;
    pages?: Array<{ n: number | null; irPageId: number; format: string | null; rendered: boolean }> | null;
  }>;
  // Phase 2: claim-level synthesis is the single source of truth for the
  // consolidated InjuryTreatmentSummary card. Replaces the old per-doc
  // analysis rendering pattern.
  aiSynthesis?: any;
  synthesisStatus?: string | null;
  pendingReconcile?: any;
}

const Index = () => {
  const { toast } = useToast();
  // The Review Queue is the home view. The "analyze" view has no nav button of
  // its own anymore — it's the claim viewer, reached by selecting a claim.
  const [activeView, setActiveView] = useState<"analyze" | "upload" | "queue" | "completed" | "logic">("queue");
  const [claimContext, setClaimContext] = useState<ClaimContext>({
    claimNumber: "",
    claimType: "",
    incidentDate: "",
    incidentDescription: "",
    claimantName: "",
    documents: [],
  });
  const [showDetailsPanel, setShowDetailsPanel] = useState(true);
  const [analysisKey, setAnalysisKey] = useState(0);

  const handleSelectClaim = async (claimId: string) => {
    try {
      const { data: claim, error: claimError } = await supabase
        .from("claims")
        .select(
          `id, source, claim_number, claim_type, incident_date, incident_description, claimant_name,
           ai_synthesis, synthesis_status, pending_reconcile, synthesis_human_edited_at,
           claim_documents (id, file_name, document_type, file_url, ai_summary, ai_analysis, claim_details, processing_status,
             source, sor_document_id, sor_document_type_code, sor_document_date,
             sor_page_count, sor_folder_id, sor_folder_name, sor_folder_path, sor_pages,
             sor_removed_at)`,
        )
        .eq("id", claimId)
        .single();

      if (claimError || !claim) {
        console.error("Error fetching claim:", claimError);
        toast({ title: "Error", description: "Failed to load claim details", variant: "destructive" });
        return;
      }

      const documents = (claim.claim_documents || [])
        // Keep superseded rows that are part of the resplit hierarchy so the tree
        // can fold them: Sor heads (own the page-collection identity + full
        // manifest) AND intermediate fetch/resplit parents (resplit_of set) — the
        // latter lets a 2-level split (head → part → 15-page chunks) collapse into
        // the single source document instead of leaking the chunks as loose rows.
        // Soft-removed docs (no longer present in Sor) drop out entirely.
        .filter((doc: any) =>
          doc.sor_removed_at == null && (
            doc.processing_status !== "superseded" ||
            doc.sor_document_id != null ||
            doc.claim_details?.resplit_of != null
          )
        )
        .map((doc: any) => ({
        id: doc.id,
        fileName: doc.file_name,
        documentType: doc.document_type,
        fileUrl: doc.file_url,
        summary: doc.ai_summary,
        analysis: doc.ai_analysis,
        pageStart: doc.claim_details?.page_start ?? null,
        pageEnd: doc.claim_details?.page_end ?? null,
        resplitOf: doc.claim_details?.resplit_of ?? null,
        originalFileName: doc.claim_details?.original_file_name ?? null,
        source: doc.source ?? null,
        processingStatus: doc.processing_status ?? null,
        sorDocumentId: doc.sor_document_id ?? null,
        documentTypeCode: doc.sor_document_type_code ?? null,
        documentDate: doc.sor_document_date ?? null,
        pageCount: doc.sor_page_count ?? null,
        folderName: doc.sor_folder_name ?? null,
        folderPath: doc.sor_folder_path ?? null,
        pages: doc.sor_pages ?? null,
      }));

      setClaimContext({
        id: claim.id,
        source: (claim as { source?: "manual" | "sor" }).source,
        claimNumber: claim.claim_number,
        claimType: claim.claim_type || "",
        incidentDate: claim.incident_date || "",
        incidentDescription: claim.incident_description || "",
        claimantName: claim.claimant_name || "",
        documents,
        aiSynthesis: (claim as { ai_synthesis?: unknown }).ai_synthesis ?? null,
        synthesisStatus: (claim as { synthesis_status?: string | null }).synthesis_status ?? null,
        pendingReconcile: (claim as { pending_reconcile?: unknown }).pending_reconcile ?? null,
      });

      setAnalysisKey((prev) => prev + 1);
      setActiveView("analyze");
    } catch (error) {
      console.error("Error loading claim:", error);
      toast({ title: "Error", description: "Failed to load claim", variant: "destructive" });
    }
  };

  const handleNewAnalysis = () => {
    setClaimContext({
      claimNumber: "",
      claimType: "",
      incidentDate: "",
      incidentDescription: "",
      claimantName: "",
      documents: [],
    });
    setAnalysisKey((prev) => prev + 1);
    setActiveView("upload");
  };

  return (
    <ProcessingProvider>
      <div className="bg-background text-on-surface flex h-screen overflow-hidden">
        <div className="hidden lg:block">
          <Sidebar activeView={activeView} onViewChange={setActiveView} onNewAnalysis={handleNewAnalysis} />
        </div>

        <main className="flex-grow flex flex-col min-w-0">
          <Header
            leftSlot={
              activeView === "analyze" && claimContext.id ? (
                <div className="flex items-center gap-3 bg-surface-container-low border border-outline-variant rounded-full px-4 py-1.5 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon name="assignment" size={16} className="text-on-surface-variant shrink-0" />
                    <span className="text-label-md text-on-surface-variant shrink-0">Claim Number:</span>
                    <span
                      className={cn(
                        "text-label-md font-mono truncate",
                        claimContext.claimNumber ? "font-bold text-secondary" : "text-outline",
                      )}
                    >
                      {claimContext.claimNumber || "—"}
                    </span>
                  </div>
                  <span className="h-3 w-px bg-outline-variant shrink-0" />
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon name="person" size={16} className="text-on-surface-variant shrink-0" />
                    <span className="text-label-md text-on-surface-variant shrink-0">Claimant Name:</span>
                    <span
                      className={cn(
                        "text-label-md truncate",
                        claimContext.claimantName ? "font-semibold text-on-surface" : "text-outline",
                      )}
                    >
                      {claimContext.claimantName || "—"}
                    </span>
                  </div>
                </div>
              ) : activeView === "queue" || activeView === "completed" || activeView === "analyze" ? (
                <HeaderClaimSearch onSelectClaim={handleSelectClaim} />
              ) : null
            }
          />

          {/* Mobile tab bar */}
          <div className="lg:hidden border-b border-outline-variant bg-surface-container-lowest">
            <div className="flex">
              {(["queue", "completed", "logic"] as const).map((view) => (
                <button
                  key={view}
                  onClick={() => setActiveView(view)}
                  className={cn(
                    "flex-1 py-3 px-4 text-body-md border-b-2 transition-colors capitalize",
                    activeView === view
                      ? "border-secondary text-primary font-bold"
                      : "border-transparent text-on-surface-variant hover:text-on-surface",
                  )}
                >
                  {view === "logic" ? "Logic" : view}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-grow flex overflow-hidden">
            {activeView === "analyze" && (
              <>
                <section className="flex-grow flex flex-col bg-surface overflow-hidden">
                  <ClaimsAgent
                    key={analysisKey}
                    claimContext={claimContext}
                    onClaimContextChange={setClaimContext}
                    onNewAnalysis={handleNewAnalysis}
                    onOpenQueue={() => setActiveView("queue")}
                    onReloadClaim={(id) => handleSelectClaim(id)}
                  />
                </section>
                <ClaimDetailsPanel
                  claimContext={claimContext}
                  onClaimContextChange={setClaimContext}
                  isVisible={showDetailsPanel}
                  onToggle={() => setShowDetailsPanel(!showDetailsPanel)}
                />
              </>
            )}

            {activeView === "upload" && <NewAnalysisUpload onGoToQueue={() => setActiveView("queue")} />}

            {activeView === "queue" && <ClaimsQueue type="pending" onSelectClaim={handleSelectClaim} />}

            {activeView === "completed" && <ClaimsQueue type="completed" onSelectClaim={handleSelectClaim} />}

            {activeView === "logic" && <ClaimsLogicDiagram />}
          </div>
        </main>
      </div>
    </ProcessingProvider>
  );
};

export default Index;
