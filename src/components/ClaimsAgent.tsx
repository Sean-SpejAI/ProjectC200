import { useState, useRef, useEffect, useCallback } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { DemandReviewCard } from "./DemandReviewCard";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUserRole } from "@/hooks/useUserRole";
import type { AuditEntry } from "./DemandReviewCard";

interface Message {
  id: string;
  role: "agent" | "user";
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
  documentAnalysis?: DemandReviewAnalysis;
}

interface DemandReviewAnalysis {
  summary: string;
  
  // Extracted claim identifiers from document
  extractedClaimNumber?: string;
  extractedClaimType?: string;
  
  // New template format
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
  };
  diagnosedInjuries?: Array<{ injury: string; scarringNoted?: boolean; pageRef?: string }>;
  priorInjuries?: string;
  treatmentRecap?: {
    narrative?: string;
    providers?: string[];
    totalVisits?: string;
    surgery?: boolean;
    injections?: boolean;
    imaging?: string[];
    pageRefs?: string;
  };
  impactToLife?: string;
  claimedWageLoss?: string;
  medicalBillBreakdown?: Array<{
    date?: string;
    provider?: string;
    complaintsOrDiagnosis?: string;
    type?: string;
    amountBilled?: string;
    healthInsurancePaid?: string;
    pageRef?: string;
  }>;
  postAccidentRecap?: Array<{ provider: string; summary: string; cptCodes?: string[]; pageRefs?: string }>;
  preAccidentRecap?: Array<{ provider: string; summary: string; cptCodes?: string[]; pageRefs?: string }>;
  verification?: {
    status: "verified" | "needs_review" | "rejected";
    dateAlignment?: string;
    nameMatch?: string;
    injuryConsistency?: string;
    costReasonableness?: string;
    notes?: string;
  };
  
  // Legacy fields for backward compatibility
  provider?: string;
  documentDate?: string;
  patientName?: string;
  demandReview?: {
    dateOfAccident?: string;
    accidentType?: string;
    attorneyRepresented?: { isRepresented: boolean; attorneyName?: string; lawFirm?: string };
    timeLimitDemand?: string;
    demandAmount?: string;
  };
  injuries?: {
    diagnosedInjuries?: Array<{ injury: string; scarringNoted?: boolean; severity?: string }>;
    priorInjuries?: string[];
  };
  treatmentSummary?: {
    providers?: string[];
    totalVisits?: string;
    surgeryPerformed?: boolean;
    injectionsReceived?: boolean;
    imagingPerformed?: { performed: boolean; types?: string[] };
    treatmentNarrative?: string;
  };
  financials?: {
    claimedWageLoss?: { amount?: string; period?: string; employer?: string };
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
  
  flags?: string[];
  recommendedActions?: string[];
  confidenceScore?: number;

  // Raw fallback fields when structured parsing fails
  rawAnalysis?: boolean;
  rawContent?: string;
}

interface ClaimContext {
  id?: string;
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
    analysis?: DemandReviewAnalysis;
    /** Original-doc page where this slice starts (claim_details.page_start); null for non-split. */
    pageStart?: number | null;
  }>;
  // Phase 2: claim-level synthesis is the source of truth for the consolidated
  // InjuryTreatmentSummary card. The per-doc `analysis` field above is no longer
  // rendered by this component; it remains in the type for backwards-compat with
  // any callers that still populate it.
  aiSynthesis?: DemandReviewAnalysis | null;
  synthesisStatus?: string | null;
  // A reconcile detected on a human-edited claim, held for approval.
  pendingReconcile?: {
    mode: "incremental" | "full";
    diff: {
      added: Array<{ docId: number; name: string }>;
      modified: Array<{ docId: number; name: string }>;
      removedCount: number;
      folderChanged: boolean;
      storedCount: number;
      freshCount: number;
    };
    detected_at: string;
  } | null;
}

interface ClaimsAgentProps {
  claimContext?: ClaimContext;
  onClaimContextChange?: (context: ClaimContext) => void;
  onNewAnalysis?: () => void;
  onOpenQueue?: () => void;
  /** Re-fetch + re-render a claim by id (used to refresh after an approved reconcile). */
  onReloadClaim?: (claimId: string) => void;
}

export function ClaimsAgent({ claimContext, onClaimContextChange, onNewAnalysis, onOpenQueue, onReloadClaim }: ClaimsAgentProps) {
  const { toast } = useToast();
  
  // Generate unique IDs using a counter combined with timestamp
  const messageIdCounter = useRef(0);
  const generateMessageId = useCallback(() => {
    messageIdCounter.current += 1;
    return `msg-${Date.now()}-${messageIdCounter.current}`;
  }, []);

  const [messages, setMessages] = useState<Message[]>([
    {
      id: "initial-greeting",
      role: "agent",
      content: "Hello! I'm your Nodak Insurance claims document analyst. I can help you review medical records, receipts, and other documents for bodily injury claims.\n\nTo get started, please provide the claim details or upload documents for analysis. I'll review each document, summarize the key information, and verify it corresponds to the accident claim.",
      timestamp: new Date(),
    },
  ]);
  const [inputValue, setInputValue] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [loadedDocIds, setLoadedDocIds] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // Audit Trail (admin / claims manager): per-field change history.
  const { isAdmin, isClaimsManager } = useUserRole();
  const canAudit = isAdmin() || isClaimsManager();
  const [auditMode, setAuditMode] = useState(false);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  // Latest in-card edits (from DemandReviewCard) — persisted on Save to Queue.
  const editedAnalysisRef = useRef<DemandReviewAnalysis | null>(null);
  // Always-current claimContext, so post-await handlers don't merge into a stale
  // snapshot (which would clobber concurrent edits from sibling panels).
  const claimContextRef = useRef(claimContext);
  claimContextRef.current = claimContext;
  // Reconcile approval (held ImageRight change on a human-edited claim).
  const [reconcileDetailsOpen, setReconcileDetailsOpen] = useState(false);
  const [isApprovingReconcile, setIsApprovingReconcile] = useState(false);
  // Post-approve poll: timer handle + the claim id it's anchored to. The id ref
  // is the abort signal — nulled on unmount so an orphaned poll can't reload.
  const reconcilePollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconcilePollIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Stop the post-approve poll on unmount (claim switch remounts this component
  // via its analysisKey key), so a dead instance can't fire onReloadClaim.
  useEffect(() => () => {
    if (reconcilePollTimer.current) clearTimeout(reconcilePollTimer.current);
    reconcilePollIdRef.current = null;
  }, []);

  // Reset per-claim edit + audit state when the selected claim changes.
  useEffect(() => {
    editedAnalysisRef.current = null;
    setAuditMode(false);
    setAuditEntries([]);
  }, [claimContext?.id]);

  // Load the field-level audit trail for the current claim (admin/manager only).
  const loadAuditEntries = useCallback(async (claimId: string) => {
    const { data } = await supabase
      .from("claim_field_audit")
      .select("field_path, field_label, old_value, changed_by, changed_by_kind, changed_at")
      .eq("claim_id", claimId)
      .order("changed_at", { ascending: false });
    if (!data) { setAuditEntries([]); return; }
    const ids = [...new Set(data.map((r) => r.changed_by).filter(Boolean))] as string[];
    let names = new Map<string, string>();
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("user_id, full_name").in("user_id", ids);
      names = new Map((profs ?? []).map((p) => [p.user_id as string, (p.full_name ?? "") as string]));
    }
    setAuditEntries(data.map((r) => ({
      path: r.field_path as string,
      label: (r.field_label as string) ?? (r.field_path as string),
      previous: r.old_value,
      by: r.changed_by_kind === "ai" ? "AI Analysis" : (names.get(r.changed_by as string) || "Unknown user"),
      at: r.changed_at as string,
      kind: r.changed_by_kind as "human" | "ai",
    })));
  }, []);

  const toggleAuditMode = async () => {
    const next = !auditMode;
    setAuditMode(next);
    if (next && claimContext?.id) await loadAuditEntries(claimContext.id);
  };

  // Approve / dismiss a held ImageRight reconcile.
  const handleReconcileDecision = async (approved: boolean) => {
    if (!claimContext?.id) return;
    setIsApprovingReconcile(true);
    try {
      const { error } = await supabase.functions.invoke("approve-reconcile", {
        body: { claimId: claimContext.id, approved },
      });
      if (error) throw error;
      toast({
        title: approved ? "Applying changes…" : "Dismissed",
        description: approved
          ? "Re-running the analysis with the latest ImageRight data."
          : "The pending ImageRight change was dismissed.",
      });
      setReconcileDetailsOpen(false);
      onClaimContextChange?.({ ...claimContextRef.current, pendingReconcile: null }); // hide the notice (use latest snapshot)
      // The approved reconcile applies in the BACKGROUND (edge fn waitUntil), so
      // poll synthesis_status and reload the claim once it settles, otherwise the
      // card stays on the stale analysis. Bounded (~3 min); aborts if the user
      // navigates to another claim.
      if (approved && claimContext.id) {
        const id = claimContext.id;
        // Capture the pre-approve synthesized_at so we only treat 'completed' as
        // done once a NEW synthesis has actually landed (not a stale/noop status).
        const { data: pre } = await supabase.from("claims").select("synthesized_at").eq("id", id).maybeSingle();
        const preSynthAt = pre?.synthesized_at ?? null;
        reconcilePollIdRef.current = id; // abort anchor
        let tries = 0;
        const poll = async () => {
          if (reconcilePollIdRef.current !== id) return; // aborted (claim switch / unmount)
          tries += 1;
          const { data } = await supabase
            .from("claims").select("synthesis_status, synthesized_at").eq("id", id).maybeSingle();
          if (reconcilePollIdRef.current !== id) return; // re-check after the await
          const st = data?.synthesis_status;
          const advanced = (data?.synthesized_at ?? null) !== preSynthAt;
          const done = st === "failed" || st === "skipped" || (st === "completed" && advanced);
          if (done || tries >= 45) { onReloadClaim?.(id); return; } // reload on completion OR timeout
          reconcilePollTimer.current = setTimeout(poll, 4000);
        };
        reconcilePollTimer.current = setTimeout(poll, 4000);
      }
    } catch {
      toast({ title: "Error", description: "Failed to submit your decision.", variant: "destructive" });
    } finally {
      setIsApprovingReconcile(false);
    }
  };
  // Only auto-scroll the chat to the bottom for USER-initiated chat turns — not
  // on initial analysis load / claim switch (which should render at the top).
  const userInitiatedScrollRef = useRef(false);

  // Check if we have any documents analyzed
  const hasAnalyzedDocuments = claimContext?.documents && claimContext.documents.length > 0;

  // Handle saving claim to review queue
  const handleSaveToQueue = async () => {
    if (!claimContext) return;
    
    setIsSaving(true);
    try {
      // Get current user
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // IMPORTANT: Look up the claim by document's claim_id first (most reliable),
      // then fall back to claim_number lookup. This prevents creating duplicate claims
      // when the UI state has a stale claim number.
      let claimId: string | null = null;
      let claimNumber: string | null = null;
      
      // First, try to get the claim_id from the first document (most reliable source)
      if (claimContext.documents.length > 0) {
        const docId = claimContext.documents[0].id;
        const { data: docData } = await supabase
          .from('claim_documents')
          .select('claim_id')
          .eq('id', docId)
          .maybeSingle();
        
        if (docData?.claim_id) {
          claimId = docData.claim_id;
          
          // Get the authoritative claim number from the database
          const { data: claimData } = await supabase
            .from('claims')
            .select('id, claim_number, status')
            .eq('id', claimId)
            .single();
          
          if (claimData) {
            claimNumber = claimData.claim_number;
            console.log('Found claim via document:', { claimId, claimNumber });
          }
        }
      }
      
      // Fallback: look up by claim_number if no document-based lookup succeeded
      if (!claimId && claimContext.claimNumber) {
        const { data: existingClaim } = await supabase
          .from('claims')
          .select('id, claim_number, status')
          .eq('claim_number', claimContext.claimNumber)
          .maybeSingle();
        
        if (existingClaim) {
          claimId = existingClaim.id;
          claimNumber = existingClaim.claim_number;
        }
      }

      if (claimId) {
        // Persist any in-card edits (+ record the field-level audit trail + the
        // human-edit reconcile flag) and set status='in_review' via the edge fn.
        // Falls back to a status-only update when there's no analysis to save.
        const analysisToSave = editedAnalysisRef.current ?? claimContext.aiSynthesis ?? null;
        if (analysisToSave) {
          const { error } = await supabase.functions.invoke("save-claim-analysis", {
            body: { claimId, aiSynthesis: analysisToSave },
          });
          if (error) throw error;
          editedAnalysisRef.current = null;
          // Refresh the inline change-history if the Audit Trail panel is open.
          if (auditMode) await loadAuditEntries(claimId);
        } else {
          await supabase
            .from('claims')
            .update({ status: 'in_review', updated_at: new Date().toISOString() })
            .eq('id', claimId);
        }
      } else {
        // Create new claim with in_review status (rare case - no documents yet)
        // Use TEMP- prefix instead of NDK- for temporary IDs
        const tempId = `TEMP-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const { data: newClaim } = await supabase
          .from('claims')
          .insert({
            claim_number: claimContext.claimNumber || tempId,
            claim_type: claimContext.claimType || 'auto',
            incident_date: claimContext.incidentDate || null,
            incident_description: claimContext.incidentDescription || null,
            claimant_name: claimContext.claimantName || null,
            status: 'in_review',
            assigned_to: user.id,
          })
          .select('claim_number')
          .single();
        
        claimNumber = newClaim?.claim_number || claimContext.claimNumber;
      }

      toast({
        title: "Saved to Queue",
        description: `Claim ${claimNumber || claimContext.claimNumber} has been saved to the review queue.`,
      });
    } catch (error) {
      console.error('Save error:', error);
      toast({
        title: "Error",
        description: "Failed to save to queue. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Handle deleting the current analysis
  const handleDeleteAnalysis = async () => {
    if (!claimContext) return;
    
    setIsDeleting(true);
    try {
      // Delete claim and related documents from database
      const { data: existingClaim } = await supabase
        .from('claims')
        .select('id')
        .eq('claim_number', claimContext.claimNumber)
        .maybeSingle();

      if (existingClaim) {
        // Delete documents first (cascade should handle this but being explicit)
        await supabase
          .from('claim_documents')
          .delete()
          .eq('claim_id', existingClaim.id);

        // Delete the claim
        await supabase
          .from('claims')
          .delete()
          .eq('id', existingClaim.id);
      }

      // Delete files from storage
      if (claimContext.documents.length > 0) {
        const filePaths = claimContext.documents
          .map(doc => {
            // file_url is now a bare storage path (legacy rows may be a full
            // public URL). Normalise either form to the bucket-relative path.
            const url = doc.fileUrl;
            if (!url) return null;
            const clean = url.split("?")[0].split("#")[0];
            const match = clean.match(/claim-documents\/(.+)/);
            return match ? match[1] : clean;
          })
          .filter(Boolean) as string[];

        if (filePaths.length > 0) {
          await supabase.storage
            .from('claim-documents')
            .remove(filePaths);
        }
      }

      toast({
        title: "Analysis Deleted",
        description: "The analysis has been deleted.",
      });

      // Start fresh
      if (onNewAnalysis) {
        onNewAnalysis();
      }
    } catch (error) {
      console.error('Delete error:', error);
      toast({
        title: "Error",
        description: "Failed to delete analysis. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // Load persisted documents into the chat on mount or when claimContext changes.
  // Phase 2: per-document chat messages ("I've uploaded X.pdf" / "I've analyzed X.pdf")
  // are intentionally NOT replayed. The right-sidebar UPLOADED DOCUMENTS panel
  // already shows the file list, and the consolidated DemandReviewCard above
  // sources from claims.ai_synthesis. Per-doc chat narration on claim load adds
  // noise without information.
  useEffect(() => {
    if (claimContext?.documents && claimContext.documents.length > 0) {
      const newMessages: Message[] = [];
      const newLoadedIds = new Set(loadedDocIds);

      claimContext.documents.forEach((doc) => {
        // Skip if already loaded
        if (loadedDocIds.has(doc.id)) return;
        newLoadedIds.add(doc.id);
        // No-op: deliberately don't emit per-doc messages here.
      });

      if (newMessages.length > 0) {
        setLoadedDocIds(newLoadedIds);
        setMessages(prev => [...prev, ...newMessages]);
      }
    }
  }, [claimContext?.documents]);

  // Log on mount for debugging - deduplication guard persists in context across remounts
  useEffect(() => {
    console.log('ClaimsAgent mounted - deduplication guard persists in ProcessingContext');
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    // Skip on initial analysis load / claim switch; only follow a live chat turn.
    if (userInitiatedScrollRef.current) scrollToBottom();
  }, [messages]);

  // Reset scroll intent when the active claim changes, so loading/switching a
  // claim renders at the top (the INJURY/TREATMENT SUMMARY) instead of jumping
  // to the chat at the bottom of the page.
  useEffect(() => {
    userInitiatedScrollRef.current = false;
  }, [claimContext?.id]);

  const streamChat = useCallback(async (userMessage: string) => {
    setIsTyping(true);
    
    const assistantMessageId = generateMessageId();
    setMessages(prev => [...prev, {
      id: assistantMessageId,
      role: "agent",
      content: "",
      timestamp: new Date(),
      isStreaming: true,
    }]);

    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/claims-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          message: userMessage,
          claimContext: claimContext ? {
            claimNumber: claimContext.claimNumber,
            claimType: claimContext.claimType,
            incidentDate: claimContext.incidentDate,
            incidentDescription: claimContext.incidentDescription,
            documents: claimContext.documents.map(d => ({
              fileName: d.fileName,
              documentType: d.documentType,
              summary: d.summary,
            })),
          } : undefined,
          conversationHistory,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to get response');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let assistantContent = "";
      let textBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        textBuffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = textBuffer.indexOf("\n")) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);

          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantContent += content;
              setMessages(prev => prev.map(msg => 
                msg.id === assistantMessageId 
                  ? { ...msg, content: assistantContent }
                  : msg
              ));
            }
          } catch {
            textBuffer = line + "\n" + textBuffer;
            break;
          }
        }
      }

      setMessages(prev => prev.map(msg => 
        msg.id === assistantMessageId 
          ? { ...msg, isStreaming: false }
          : msg
      ));

      setConversationHistory(prev => [
        ...prev,
        { role: 'user', content: userMessage },
        { role: 'assistant', content: assistantContent },
      ]);

    } catch (error) {
      console.error('Chat error:', error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to get response",
        variant: "destructive",
      });
      setMessages(prev => prev.filter(msg => msg.id !== assistantMessageId));
    } finally {
      setIsTyping(false);
    }
  }, [claimContext, conversationHistory, toast, generateMessageId]);

  const handleInputSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isTyping) return;

    const userMessage = inputValue.trim();
    setInputValue("");

    // A real chat turn — from here, auto-scroll to follow the conversation.
    userInitiatedScrollRef.current = true;

    setMessages(prev => [...prev, {
      id: generateMessageId(),
      role: "user",
      content: userMessage,
      timestamp: new Date(),
    }]);

    await streamChat(userMessage);
  };


  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Top context bar */}
      {hasAnalyzedDocuments && (
        <div className="px-6 py-3 bg-surface border-b border-outline-variant">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="bg-surface-container-low px-4 py-1.5 rounded-full border border-outline-variant flex items-center gap-2">
                <span className="text-label-md text-on-surface-variant">
                  {claimContext?.documents.length} document(s) analyzed
                </span>
                <span className="h-3 w-px bg-outline-variant" />
                <span className="text-label-md text-outline">
                  Claim: {claimContext?.claimNumber}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {canAudit && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={toggleAuditMode}
                  className={cn(
                    "gap-2 border-outline-variant text-on-surface-variant",
                    auditMode && "bg-amber-100 border-amber-300 text-amber-800 hover:bg-amber-100",
                  )}
                >
                  <Icon name="history" size={16} />
                  <span className="text-label-md">Audit Trail</span>
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={onNewAnalysis}
                className="gap-2 border-outline-variant text-on-surface-variant"
              >
                <Icon name="replay" size={16} />
                <span className="text-label-md">Start Over</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSaveToQueue}
                disabled={isSaving}
                className="gap-2 border-outline-variant text-on-surface-variant"
              >
                {isSaving ? (
                  <Icon name="progress_activity" size={16} className="animate-spin" />
                ) : (
                  <Icon name="save" size={16} />
                )}
                <span className="text-label-md">Save to Queue</span>
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 border-destructive/20 text-destructive hover:bg-destructive/5"
                  >
                    <Icon name="delete" size={16} />
                    <span className="text-label-md">Delete</span>
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Analysis?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete the analysis for claim {claimContext?.claimNumber} and all
                      associated documents. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDeleteAnalysis}
                      disabled={isDeleting}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {isDeleting ? (
                        <Icon name="progress_activity" size={16} className="animate-spin mr-2" />
                      ) : null}
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
          {claimContext?.pendingReconcile && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5">
              <div className="flex items-center gap-2 text-sm text-amber-900">
                <Icon name="warning" size={18} className="text-amber-600 shrink-0" />
                <span>
                  ImageRight Data has changed, okay to{" "}
                  <strong>{claimContext.pendingReconcile.mode === "full" ? "reprocess" : "update"}</strong>{" "}
                  the analysis?
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setReconcileDetailsOpen(true)}
                  className="gap-1.5 border-amber-300 text-amber-800 hover:bg-amber-100"
                >
                  <Icon name="info" size={15} />
                  <span className="text-label-md">Change Details</span>
                </Button>
                <Button
                  size="sm"
                  disabled={isApprovingReconcile}
                  onClick={() => handleReconcileDecision(true)}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {claimContext.pendingReconcile.mode === "full" ? "Reprocess" : "Update"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isApprovingReconcile}
                  onClick={() => handleReconcileDecision(false)}
                  className="text-amber-800"
                >
                  Dismiss
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Change Details — what reconciliation found + what approval will do. */}
      {claimContext?.pendingReconcile && (
        <Dialog open={reconcileDetailsOpen} onOpenChange={setReconcileDetailsOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>ImageRight change details</DialogTitle>
              <DialogDescription>
                {claimContext.pendingReconcile.mode === "full"
                  ? "This is a large change. Approving will REPROCESS the claim: wipe the current documents + analysis, re-pull everything from ImageRight, and re-run the full analysis. Your manual edits will be replaced (they remain in the audit trail)."
                  : "Approving will UPDATE the claim: fetch + analyze the new/changed documents, drop any removed ones, and re-synthesize the summary. Your manual edits to the analysis may be replaced by the refreshed summary (they remain in the audit trail)."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              {claimContext.pendingReconcile.diff.added.length > 0 && (
                <div>
                  <div className="font-semibold text-emerald-700">New documents ({claimContext.pendingReconcile.diff.added.length})</div>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {claimContext.pendingReconcile.diff.added.slice(0, 12).map((d) => <li key={d.docId}>{d.name}</li>)}
                    {claimContext.pendingReconcile.diff.added.length > 12 && (
                      <li className="italic">…and {claimContext.pendingReconcile.diff.added.length - 12} more</li>
                    )}
                  </ul>
                </div>
              )}
              {claimContext.pendingReconcile.diff.modified.length > 0 && (
                <div>
                  <div className="font-semibold text-amber-700">Changed documents ({claimContext.pendingReconcile.diff.modified.length})</div>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {claimContext.pendingReconcile.diff.modified.slice(0, 12).map((d) => <li key={d.docId}>{d.name}</li>)}
                    {claimContext.pendingReconcile.diff.modified.length > 12 && (
                      <li className="italic">…and {claimContext.pendingReconcile.diff.modified.length - 12} more</li>
                    )}
                  </ul>
                </div>
              )}
              {claimContext.pendingReconcile.diff.removedCount > 0 && (
                <div className="font-semibold text-destructive">
                  {claimContext.pendingReconcile.diff.removedCount} document(s) removed from ImageRight
                </div>
              )}
              {claimContext.pendingReconcile.diff.folderChanged && (
                <div className="text-amber-700">Folder structure was reorganized.</div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" disabled={isApprovingReconcile} onClick={() => handleReconcileDecision(false)}>Dismiss</Button>
              <Button
                size="sm"
                disabled={isApprovingReconcile}
                onClick={() => handleReconcileDecision(true)}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {isApprovingReconcile && <Icon name="progress_activity" size={15} className="mr-1.5 animate-spin" />}
                {claimContext.pendingReconcile.mode === "full" ? "Reprocess analysis" : "Update analysis"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Chat Messages */}
      <div className="flex-1 overflow-y-auto scrollbar-hide p-6 lg:px-10">
        <div className="max-w-5xl w-full space-y-6">
          {/* Empty-state welcome panel — replaces the chatbot greeting when
              nothing has been loaded or uploaded yet. Once the user selects a
              claim (claimContext.id set), uploads a document (documents.length
              > 0), or accumulates any conversation beyond the synthetic
              initial greeting, the normal chat flow takes over. */}
          {!claimContext?.id &&
          (claimContext?.documents?.length ?? 0) === 0 &&
          messages.length <= 1 ? (
            <div className="flex flex-col items-center justify-center text-center py-16 px-4 animate-fade-in">
              <div className="w-16 h-16 rounded-full bg-secondary-container flex items-center justify-center mb-4">
                <Icon name="inbox" size={32} className="text-on-secondary-container" filled />
              </div>
              <h2 className="text-headline-md text-primary mb-3">Welcome to Claims Review</h2>
              <p className="text-body-md text-on-surface-variant max-w-md mb-6">
                Open the <span className="font-semibold text-on-surface">Review Queue</span> to
                find a claim that needs your attention, search by claim number or claimant name
                in the top bar, or click <span className="font-semibold text-on-surface">New Analysis</span> to upload documents for a new claim.
              </p>
              <Button
                onClick={() => onOpenQueue?.()}
                className="gap-2 bg-secondary text-secondary-foreground hover:brightness-110"
              >
                <Icon name="list_alt" size={18} />
                Open Review Queue
              </Button>
            </div>
          ) : null}

          {/* Phase 2: consolidated claim-level analysis card.
              ONE card per claim, sourced from claims.ai_synthesis (which the
              synthesize-claim-extraction edge function reconciles + dedupes
              across every PDF on the claim). Replaces the previous N-cards-
              per-N-PDFs pattern.
              States:
              - every doc has no fileUrl → source-empty banner (no PDF in
                ImageRight, can't analyze)
              - synthesis present + ready → render card from ai_synthesis
              - synthesis_status='running' → "Consolidating..." placeholder
              - synthesis_status='failed' or null → small note, no card */}
          {claimContext?.documents &&
          claimContext.documents.length > 0 &&
          claimContext.documents.every((d) => !d.fileUrl) ? (
            <div className="px-4 py-3 rounded-2xl border border-warning/30 bg-warning/5 text-on-surface text-body-sm space-y-1">
              <div className="font-bold text-warning">No PDF content available in source system</div>
              <p>
                ImageRight returned an empty record for this claim's{" "}
                {claimContext.documents.length === 1 ? "document" : "documents"}.
                Try re-pulling from ImageRight using the admin{" "}
                <span className="font-medium">Reload from ImageRight</span> button — if the
                content was added after the original sync, this will recover it. Otherwise the
                source record is a placeholder with no pages.
              </p>
            </div>
          ) : claimContext?.aiSynthesis ? (
            <div className="animate-fade-in">
              <DemandReviewCard
                analysis={claimContext.aiSynthesis as unknown as DemandReviewAnalysis}
                claimNumber={claimContext.claimNumber}
                documents={claimContext.documents}
                onAnalysisChange={(a) => { editedAnalysisRef.current = a; }}
                auditMode={auditMode}
                auditEntries={auditEntries}
              />
            </div>
          ) : claimContext?.synthesisStatus === "running" ? (
            <div className="px-4 py-3 rounded-2xl border border-outline-variant bg-surface-container-low text-on-surface-variant text-body-sm">
              Consolidating analysis across {claimContext.documents.length} document
              {claimContext.documents.length === 1 ? "" : "s"}…
            </div>
          ) : claimContext?.synthesisStatus === "failed" ? (
            <div className="px-4 py-3 rounded-2xl border border-destructive/30 bg-destructive/5 text-destructive text-body-sm">
              Cross-document synthesis failed. The per-document upload log is below.
            </div>
          ) : null}

          {messages
            .filter((m) => {
              // Suppress the synthetic initial-greeting bubble in the empty
              // state — the welcome panel above replaces it. Once any user
              // activity has occurred (claim selected, doc uploaded, or
              // additional messages), the greeting is no longer suppressed.
              if (m.id !== "initial-greeting") return true;
              const empty =
                !claimContext?.id &&
                (claimContext?.documents?.length ?? 0) === 0 &&
                messages.length <= 1;
              return !empty;
            })
            .map((message, index) => (
            <div
              key={message.id}
              className={cn(
                "flex gap-4 animate-fade-in items-start",
                message.role === "user" ? "flex-row-reverse" : "flex-row",
              )}
              style={{ animationDelay: `${index * 0.05}s` }}
            >
              <div
                className={cn(
                  "shrink-0 w-10 h-10 rounded-lg flex items-center justify-center shadow-elevation-1",
                  message.role === "agent"
                    ? "bg-secondary text-secondary-foreground"
                    : "bg-primary text-primary-foreground",
                )}
              >
                <Icon name={message.role === "agent" ? "smart_toy" : "person"} size={20} filled />
              </div>

              <div
                className={cn(
                  "max-w-[85%] space-y-3",
                  message.role === "user" ? "items-end" : "items-start",
                )}
              >
                <div
                  className={cn(
                    "px-4 py-3 rounded-2xl border",
                    message.role === "agent"
                      ? "bg-surface-container-low text-on-surface border-outline-variant rounded-tl-none"
                      : "bg-primary text-primary-foreground border-primary rounded-tr-none",
                  )}
                >
                  <p className="text-body-md leading-relaxed whitespace-pre-wrap">
                    {message.content}
                    {message.isStreaming && (
                      <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse" />
                    )}
                  </p>
                </div>

                {/* Phase 2: per-document DemandReviewCard is intentionally
                    NOT rendered here. We show ONE consolidated card sourced
                    from claims.ai_synthesis at the top of the chat instead —
                    see the consolidated-card block below the messages loop.
                    Per-doc messages remain as upload/analyzed status lines. */}

                <span className="text-xs text-on-surface-variant">
                  {message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            </div>
          ))}

          {isTyping && !messages.some((m) => m.isStreaming) && (
            <div className="flex gap-4 animate-fade-in">
              <div className="shrink-0 w-10 h-10 rounded-lg bg-secondary text-secondary-foreground flex items-center justify-center shadow-elevation-1">
                <Icon name="smart_toy" size={20} filled />
              </div>
              <div className="px-4 py-3 rounded-2xl rounded-tl-none bg-surface-container-low border border-outline-variant">
                <div className="agent-typing-indicator">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="border-t border-outline-variant bg-surface p-4 lg:px-10">
        <form
          onSubmit={handleInputSubmit}
          className="max-w-4xl w-full bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-elevation-2 p-2 flex items-center gap-2 border-t-2 border-t-secondary/10"
        >
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Ask about claims, documents, or medical terminology..."
            className="flex-1 border-none bg-transparent focus-visible:ring-0 text-body-lg"
            disabled={isTyping}
          />
          <button
            type="submit"
            disabled={isTyping || !inputValue.trim()}
            className="w-10 h-10 bg-secondary text-secondary-foreground rounded-lg flex items-center justify-center hover:brightness-110 shadow-sm active:scale-95 transition-all disabled:opacity-50"
          >
            <Icon name="send" size={20} />
          </button>
        </form>
      </div>
    </div>
  );
}
