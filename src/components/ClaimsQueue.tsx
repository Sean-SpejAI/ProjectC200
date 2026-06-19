import { useState, useEffect, useMemo, useRef } from "react";
import { Icon } from "@/components/Icon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ClaimApprovalActions } from "@/components/ClaimApprovalActions";
import { useUserRole } from "@/hooks/useUserRole";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface ClaimsQueueProps {
  type: "pending" | "completed";
  onSelectClaim: (claimId: string) => void;
}

interface Claim {
  id: string;
  claim_number: string;
  claimant_name: string | null;
  claim_type: string;
  incident_date: string | null;
  status: string;
  source?: "manual" | "sor" | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  review_notes: string | null;
  assigned_to: string | null;
  synthesis_status: string | null;
  claim_documents: { id: string; processing_status?: string | null; document_classifications?: unknown | null }[];
}

// Synthesis states that mean a (manual) claim is still being processed — shown
// in the pending queue as a non-clickable progress row.
const IN_PROGRESS_SYNTHESIS = new Set(["not_run", "pending", "running", "failed", "cancelled"]);
// 'superseded' = a chunk that was auto-resplit into smaller children; it is
// done as far as the parent is concerned (its children carry the real work).
const TERMINAL_DOC_STATUSES = new Set(["completed", "needs_review", "failed", "superseded"]);

// What "assigned_to" UI options to show
type AssignedFilter = "all" | "me" | "unassigned";
type SortBy = "newest" | "claim_number" | "claimant_last" | "assignee";

export function ClaimsQueue({ type, onSelectClaim }: ClaimsQueueProps) {
  const { canApproveReject } = useUserRole();
  const { user } = useAuth();
  const { toast } = useToast();
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [notesDialogOpen, setNotesDialogOpen] = useState<string | null>(null);
  const [editingNotes, setEditingNotes] = useState<string>("");
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  // assigned_to UUID -> display name, for the "assignee" sort.
  const [profileNames, setProfileNames] = useState<Map<string, string>>(new Map());

  // Phase 2.3 filters — applied client-side after the base fetch (already
  // gated server-side by claim.status). For a corpus of <2000 claims this
  // is cheap and avoids re-querying on every keystroke.
  const [searchClaimNumber, setSearchClaimNumber] = useState("");
  const [searchClaimant, setSearchClaimant] = useState("");
  const [statusValues, setStatusValues] = useState<Set<string>>(new Set());
  const [assignedFilter, setAssignedFilter] = useState<AssignedFilter>("all");

  const statusOptions = type === "pending" ? ["pending", "in_review"] : ["approved", "rejected", "completed"];

  // Throttle refresh signals so a fast-firing realtime stream during backfill
  // doesn't trigger constant fetches.
  const refreshTimerRef = useRef<number | null>(null);
  const scheduleRefresh = (fn: () => void, delayMs = 5000) => {
    if (refreshTimerRef.current !== null) return; // a refresh is already scheduled
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      fn();
    }, delayMs);
  };

  // Phase 2: visibility predicate is now "synthesis completed" — strictly
  // requires the full pipeline (Pass 0 → analyze → grounding → synthesis)
  // to have produced an ai_synthesis JSON for the claim. Hides:
  //   - parked / failed-to-analyze claims (synthesis_status='not_run')
  //   - in-flight claims (synthesis_status='running')
  //   - failed-synthesis claims (synthesis_status='failed')
  //   - any old/pre-Phase-2 claims that haven't been re-synthesized
  // Each visible claim is guaranteed to have a populated ai_synthesis the
  // Document Analyst page can render in the consolidated card.
  // A manually-uploaded claim still flowing through the pipeline. Shown only in
  // the pending queue, as a non-clickable progress row.
  const isInProgress = (c: Claim) =>
    type === "pending" &&
    c.source === "manual" &&
    c.synthesis_status !== "completed" &&
    IN_PROGRESS_SYNTHESIS.has(c.synthesis_status ?? "not_run");

  // Either fully synthesized (clickable) or an in-progress manual upload.
  const isClaimVisible = (c: Claim) => c.synthesis_status === "completed" || isInProgress(c);

  // Progress bar value + label for an in-progress claim.
  const progressFor = (c: Claim): { pct: number; label: string; failed: boolean; stopped: boolean } => {
    const docs = c.claim_documents ?? [];
    const total = docs.length;
    const terminal = docs.filter((d) => TERMINAL_DOC_STATUSES.has(d.processing_status ?? "")).length;
    if (c.synthesis_status === "cancelled") return { pct: 100, label: "Stopped", failed: false, stopped: true };
    if (c.synthesis_status === "failed") return { pct: 100, label: "Processing failed", failed: true, stopped: false };
    if (c.synthesis_status === "running") return { pct: 95, label: "Synthesizing…", failed: false, stopped: false };
    const pct = total > 0 ? Math.min(90, Math.round((terminal / total) * 90)) : 5;
    return {
      pct,
      label: total > 0 ? `Analyzing documents (${terminal}/${total})` : "Starting…",
      failed: false,
      stopped: false,
    };
  };

  const fetchClaims = async () => {
    try {
      setLoading(true);
      let query = supabase
        .from("claims")
        .select(
          `id, claim_number, claimant_name, claim_type, incident_date, status, source, created_at, updated_at,
           reviewed_at, review_notes, assigned_to, synthesis_status,
           claim_documents (id, processing_status, document_classifications)`,
        )
        .in("status", statusOptions);

      // Pending queue also surfaces manual uploads still being processed so the
      // user sees their submission progress; completed queue stays synthesis-only.
      query = type === "pending"
        ? query.or(
            "synthesis_status.eq.completed,and(source.eq.manual,synthesis_status.in.(not_run,pending,running,failed,cancelled))",
          )
        : query.eq("synthesis_status", "completed");

      const { data, error } = await query.order("created_at", { ascending: false });

      if (error) {
        console.error("Error fetching claims:", error);
        toast({ title: "Error", description: "Failed to load claims", variant: "destructive" });
        return;
      }

      // Belt-and-suspenders client-side check (server-side .eq already filters).
      const visible = (data ?? []).filter(isClaimVisible);
      setClaims(visible as Claim[]);
    } catch (error) {
      console.error("Error fetching claims:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClaims();

    // Stable refresh: subscribe to `claims` changes but apply them incrementally
    // instead of triggering a full re-fetch. Preserves scroll position and
    // avoids jitter when the backfill flips many rows in quick succession.
    const channel = supabase
      .channel("claims-queue-updates")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "claims" },
        (payload) => {
          const next = payload.new as Partial<Claim> & { id: string };
          setClaims((prev) => {
            const idx = prev.findIndex((c) => c.id === next.id);
            if (idx === -1) {
              // Claim wasn't in the list; if a transition made it eligible —
              // synthesis just completed, or it's a manual upload now in flight
              // in the pending queue — refresh once to fetch the full row with
              // its claim_documents relation (needed for the progress bar).
              const newStatus = next.status as string | undefined;
              const newSyn = next.synthesis_status as string | undefined;
              const becameEligible =
                newSyn === "completed" ||
                (type === "pending" && next.source === "manual" && IN_PROGRESS_SYNTHESIS.has(newSyn ?? "not_run"));
              if (newStatus && statusOptions.includes(newStatus) && becameEligible) {
                scheduleRefresh(fetchClaims);
              }
              return prev;
            }
            // Patch in place without re-sorting — no scroll jitter.
            const merged = { ...prev[idx], ...next } as Claim;
            // Drop it if the change made it no longer belong in this queue
            // (status moved out, or it's neither completed nor an in-flight manual claim).
            if (!statusOptions.includes(merged.status) || !isClaimVisible(merged)) {
              return prev.filter((c) => c.id !== merged.id);
            }
            const out = [...prev];
            out[idx] = merged;
            return out;
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "claims" },
        () => {
          // New claims arrive without their claim_documents relation in the
          // payload; throttled refresh fetches the full row.
          scheduleRefresh(fetchClaims);
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "claims" },
        (payload) => {
          const oldId = (payload.old as { id?: string })?.id;
          if (oldId) setClaims((prev) => prev.filter((c) => c.id !== oldId));
        },
      )
      .subscribe();

    // In the pending queue, also follow claim_documents so in-progress upload
    // rows advance their progress bar as each document finishes analyzing.
    // Throttled refetch keeps it cheap even during a backfill burst.
    const docsChannel =
      type === "pending"
        ? supabase
            .channel("claims-queue-doc-progress")
            .on(
              "postgres_changes",
              { event: "*", schema: "public", table: "claim_documents" },
              () => scheduleRefresh(fetchClaims),
            )
            .subscribe()
        : null;

    return () => {
      supabase.removeChannel(channel);
      if (docsChannel) supabase.removeChannel(docsChannel);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  // Resolve assignee display names for the "assignee" sort. The broadened
  // profiles SELECT policy lets any signed-in user read team members' names.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("profiles").select("user_id, full_name");
      if (cancelled || !data) return;
      setProfileNames(new Map(data.map((p) => [p.user_id as string, (p.full_name ?? "") as string])));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply client-side filters + sort
  const filteredClaims = useMemo(() => {
    let out = claims;
    if (statusValues.size > 0) {
      out = out.filter((c) => statusValues.has(c.status));
    }
    if (searchClaimNumber.trim()) {
      const q = searchClaimNumber.trim().toLowerCase();
      out = out.filter((c) => (c.claim_number ?? "").toLowerCase().includes(q));
    }
    if (searchClaimant.trim()) {
      const q = searchClaimant.trim().toLowerCase();
      out = out.filter((c) => (c.claimant_name ?? "").toLowerCase().includes(q));
    }
    if (assignedFilter === "me" && user?.id) {
      out = out.filter((c) => c.assigned_to === user.id);
    } else if (assignedFilter === "unassigned") {
      out = out.filter((c) => !c.assigned_to);
    }

    if (sortBy !== "newest") {
      // Empty / unknown keys sort last; claim numbers compare numerically.
      const cmp = (x: string, y: string) => {
        if (!x && !y) return 0;
        if (!x) return 1;
        if (!y) return -1;
        return x.localeCompare(y, undefined, { numeric: true });
      };
      const keyFor = (c: Claim): string => {
        if (sortBy === "claim_number") return c.claim_number ?? "";
        if (sortBy === "claimant_last") return (c.claimant_name ?? "").split(",")[0].trim();
        if (sortBy === "assignee") return c.assigned_to ? (profileNames.get(c.assigned_to) ?? "") : "";
        return "";
      };
      out = [...out].sort((a, b) => cmp(keyFor(a).toLowerCase(), keyFor(b).toLowerCase()));
    }
    return out;
  }, [claims, statusValues, searchClaimNumber, searchClaimant, assignedFilter, user?.id, sortBy, profileNames]);

  // In-progress manual uploads render as non-clickable progress rows above the
  // clickable, fully-synthesized claims.
  const inProgressClaims = filteredClaims.filter(isInProgress);
  const readyClaims = filteredClaims.filter((c) => !isInProgress(c));

  const toggleStatusValue = (s: string) => {
    setStatusValues((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const handleAssignToMe = async (claimId: string) => {
    if (!user?.id) {
      toast({ title: "Not signed in", description: "Cannot assign — no current user", variant: "destructive" });
      return;
    }
    try {
      setAssigningId(claimId);
      const target = claims.find((c) => c.id === claimId);
      const alreadyMine = target?.assigned_to === user.id;
      const newAssignee = alreadyMine ? null : user.id;
      const { error } = await supabase.from("claims").update({ assigned_to: newAssignee }).eq("id", claimId);
      if (error) throw error;
      setClaims((prev) => prev.map((c) => (c.id === claimId ? { ...c, assigned_to: newAssignee } : c)));
      toast({
        title: alreadyMine ? "Unassigned" : "Assigned to you",
        description: alreadyMine ? "Removed your assignment from this claim." : "You are now the assigned reviewer.",
      });
    } catch (error) {
      console.error("Error assigning claim:", error);
      toast({ title: "Error", description: "Failed to update assignment.", variant: "destructive" });
    } finally {
      setAssigningId(null);
    }
  };

  const handleStopProcessing = async (claimId: string) => {
    try {
      setStoppingId(claimId);
      // Cancel documents that haven't finished so the watchdog stops
      // re-dispatching them. A document already mid-analysis on the server may
      // still finish, but no new work will start.
      await supabase
        .from("claim_documents")
        .update({ processing_status: "cancelled" })
        .eq("claim_id", claimId)
        .in("processing_status", ["pending", "processing"]);
      // Mark the claim cancelled — blocks the synthesis trigger and renders the
      // row as "Stopped" while keeping it (so it can still be deleted).
      const { error } = await supabase.from("claims").update({ synthesis_status: "cancelled" }).eq("id", claimId);
      if (error) throw error;
      toast({
        title: "Processing stopped",
        description: "No new analysis will start. Documents already in progress may finish on their own.",
      });
      fetchClaims();
    } catch (error) {
      console.error("Error stopping processing:", error);
      toast({ title: "Error", description: "Failed to stop processing. Please try again.", variant: "destructive" });
    } finally {
      setStoppingId(null);
    }
  };

  const handleDeleteClaim = async (claimId: string, claimNumber: string) => {
    try {
      setDeletingId(claimId);
      const { data: docs } = await supabase.from("claim_documents").select("id").eq("claim_id", claimId);
      if (docs && docs.length > 0) {
        const docIds = docs.map((d) => d.id);
        await supabase.from("document_analysis_results").delete().in("document_id", docIds);
      }
      const { error: docsError } = await supabase.from("claim_documents").delete().eq("claim_id", claimId);
      if (docsError) throw docsError;
      const { error: claimError } = await supabase.from("claims").delete().eq("id", claimId);
      if (claimError) throw claimError;
      toast({ title: "Claim Deleted", description: `Claim ${claimNumber} has been deleted successfully.` });
      fetchClaims();
    } catch (error) {
      console.error("Error deleting claim:", error);
      toast({ title: "Delete Failed", description: "Failed to delete the claim. Please try again.", variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

  const handleMarkComplete = async (claimId: string, claimNumber: string) => {
    try {
      setCompletingId(claimId);
      const { error } = await supabase
        .from("claims")
        .update({ status: "completed", reviewed_at: new Date().toISOString() })
        .eq("id", claimId);
      if (error) throw error;
      toast({ title: "Review Completed", description: `Claim ${claimNumber} has been marked as complete.` });
      fetchClaims();
    } catch (error) {
      console.error("Error completing claim:", error);
      toast({ title: "Error", description: "Failed to mark review as complete.", variant: "destructive" });
    } finally {
      setCompletingId(null);
    }
  };

  const handleSaveNotes = async (claimId: string) => {
    try {
      const { error } = await supabase.from("claims").update({ review_notes: editingNotes }).eq("id", claimId);
      if (error) throw error;
      toast({ title: "Notes Saved", description: "Review notes have been saved." });
      setNotesDialogOpen(null);
      fetchClaims();
    } catch (error) {
      console.error("Error saving notes:", error);
      toast({ title: "Error", description: "Failed to save notes.", variant: "destructive" });
    }
  };

  const getTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInMs = now.getTime() - date.getTime();
    const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
    if (diffInHours < 1) return "Just now";
    if (diffInHours < 24) return `${diffInHours} hours ago`;
    if (diffInDays === 1) return "1 day ago";
    return `${diffInDays} days ago`;
  };

  const getPriorityFromDate = (dateString: string | null) => {
    if (!dateString) return "low";
    const date = new Date(dateString);
    const now = new Date();
    const diffInDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (diffInDays <= 7) return "high";
    if (diffInDays <= 14) return "medium";
    return "low";
  };

  if (loading) {
    return (
      <div className="flex-1 p-6 lg:p-8 flex items-center justify-center">
        <Icon name="progress_activity" size={32} className="animate-spin text-on-surface-variant" />
      </div>
    );
  }

  return (
    <div className="flex-1 p-6 lg:p-10 overflow-y-auto bg-surface">
      <div className="max-w-4xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-headline-md text-primary">
              {type === "pending" ? "Review Queue" : "Completed Reviews"}
            </h1>
            <p className="text-body-md text-on-surface-variant mt-1">
              {type === "pending"
                ? `${filteredClaims.length} of ${claims.length} claims awaiting document review`
                : `${filteredClaims.length} of ${claims.length} reviews completed`}
            </p>
          </div>
        </div>

        {/* Phase 2.3: filter toolbar. Filters applied client-side over the
            already-fetched queue. Status pills + claim# search + claimant
            search + assigned-to dropdown. */}
        <Card className="p-4 mb-6 bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1">
              <Icon name="filter_alt" size={16} className="text-on-surface-variant" />
              <span className="text-body-sm text-on-surface-variant mr-2">Filters</span>
            </div>

            {/* Status pills */}
            {statusOptions.map((s) => (
              <button
                key={s}
                onClick={() => toggleStatusValue(s)}
                className={cn(
                  "px-3 py-1 text-xs rounded-full border transition-colors capitalize",
                  statusValues.has(s)
                    ? "bg-primary/10 border-primary text-primary"
                    : "border-outline-variant text-on-surface-variant hover:border-outline",
                )}
                type="button"
              >
                {s.replace("_", " ")}
              </button>
            ))}

            <div className="flex-1" />

            <Input
              placeholder="Claim #"
              value={searchClaimNumber}
              onChange={(e) => setSearchClaimNumber(e.target.value)}
              className="w-32 h-9"
            />
            <Input
              placeholder="Claimant name"
              value={searchClaimant}
              onChange={(e) => setSearchClaimant(e.target.value)}
              className="w-44 h-9"
            />
            <Select value={assignedFilter} onValueChange={(v) => setAssignedFilter(v as AssignedFilter)}>
              <SelectTrigger className="w-36 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Anyone</SelectItem>
                <SelectItem value="me">Assigned to me</SelectItem>
                <SelectItem value="unassigned">Unassigned</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
              <SelectTrigger className="w-48 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Sort: Newest</SelectItem>
                <SelectItem value="claim_number">Sort: Claim number</SelectItem>
                <SelectItem value="claimant_last">Sort: Claimant last name</SelectItem>
                <SelectItem value="assignee">Sort: Assignee</SelectItem>
              </SelectContent>
            </Select>
            {(statusValues.size > 0 || searchClaimNumber || searchClaimant || assignedFilter !== "all") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStatusValues(new Set());
                  setSearchClaimNumber("");
                  setSearchClaimant("");
                  setAssignedFilter("all");
                }}
              >
                <Icon name="close" size={14} className="mr-1" />
                Clear
              </Button>
            )}
          </div>
        </Card>

        {filteredClaims.length === 0 ? (
          <Card className="p-10 text-center bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl">
            <Icon name="description" size={48} className="mx-auto mb-4 text-on-surface-variant" />
            <h3 className="text-headline-sm font-semibold mb-2 text-on-surface">No Claims Found</h3>
            <p className="text-body-md text-on-surface-variant">
              {claims.length === 0
                ? type === "pending"
                  ? "There are no claims awaiting review."
                  : "No completed reviews yet."
                : "No claims match the current filters."}
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {/* In-progress manual uploads — non-clickable, progress bar fills toward completion */}
            {inProgressClaims.map((claim) => {
              const { pct, label, failed, stopped } = progressFor(claim);
              const total = claim.claim_documents?.length || 0;
              const isDeleting = deletingId === claim.id;
              const isStopping = stoppingId === claim.id;
              const active = !failed && !stopped; // still analyzing — eligible to stop
              return (
                <Card
                  key={claim.id}
                  className={cn(
                    "p-4 animate-slide-up bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl",
                    isDeleting && "opacity-50",
                  )}
                >
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center flex-shrink-0">
                      <Icon
                        name={stopped ? "stop_circle" : failed ? "error" : "progress_activity"}
                        size={20}
                        className={active ? "animate-spin" : ""}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-xs font-bold text-secondary">{claim.claim_number}</span>
                        <Badge
                          variant="outline"
                          className="text-[10px] rounded-full border-outline-variant text-on-surface-variant"
                        >
                          {stopped ? "Stopped" : failed ? "Failed" : "Processing"}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1.5 text-on-surface font-medium mb-2">
                        <Icon name="person" size={14} className="text-on-surface-variant" />
                        {claim.claimant_name || "Not specified"}
                      </div>
                      <Progress value={pct} className={cn("h-2", failed && "[&>div]:bg-destructive")} />
                      <div className="flex items-center justify-between mt-1 text-xs text-on-surface-variant">
                        <span>{label}</span>
                        <span className="font-mono">{pct}%</span>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="flex items-center gap-1.5 text-on-surface-variant mb-1">
                        <Icon name="description" size={14} />
                        <span className="text-xs">{total} docs</span>
                      </div>
                      <span className="text-xs text-on-surface-variant">{getTimeAgo(claim.created_at)}</span>
                    </div>

                    {/* Stop (while still analyzing) + Delete (any stage) */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {active && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-on-surface-variant hover:text-warning"
                              disabled={isStopping}
                              title="Stop processing"
                            >
                              {isStopping ? (
                                <Icon name="progress_activity" size={18} className="animate-spin" />
                              ) : (
                                <Icon name="stop_circle" size={18} />
                              )}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Stop processing</AlertDialogTitle>
                              <AlertDialogDescription>
                                Stop analyzing claim <strong>{claim.claim_number}</strong>? Documents that haven't
                                started yet are cancelled and no new analysis runs. A document already in progress may
                                still finish. You can delete the claim afterward if you don't need it.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Keep processing</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleStopProcessing(claim.id)}>
                                Stop processing
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-on-surface-variant hover:text-destructive"
                            disabled={isDeleting}
                            title="Delete claim"
                          >
                            {isDeleting ? (
                              <Icon name="progress_activity" size={18} className="animate-spin" />
                            ) : (
                              <Icon name="delete" size={18} />
                            )}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete Claim</AlertDialogTitle>
                            <AlertDialogDescription>
                              Delete claim <strong>{claim.claim_number}</strong> and all its uploaded documents and
                              analysis? This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDeleteClaim(claim.id, claim.claim_number)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                </Card>
              );
            })}

            {readyClaims.map((claim, index) => {
              const priority = getPriorityFromDate(claim.incident_date);
              const isDeleting = deletingId === claim.id;

              return (
                <Card
                  key={claim.id}
                  className={cn(
                    "p-4 animate-slide-up bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl transition-colors hover:border-secondary/30",
                    isDeleting && "opacity-50",
                  )}
                  style={{ animationDelay: `${index * 0.05}s` }}
                >
                  <div className="flex items-center gap-4">
                    {type === "pending" ? (
                      <div
                        className={cn(
                          "w-1 h-12 rounded-full flex-shrink-0",
                          priority === "high" && "bg-destructive",
                          priority === "medium" && "bg-warning",
                          priority === "low" && "bg-outline",
                        )}
                      />
                    ) : (
                      <div
                        className={cn(
                          "w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0",
                          claim.status === "approved" && "bg-success/10 text-success",
                          claim.status === "rejected" && "bg-destructive/10 text-destructive",
                          claim.status === "completed" && "bg-primary/10 text-primary",
                        )}
                      >
                        <Icon name="check_circle" size={20} filled />
                      </div>
                    )}

                    <div
                      className="flex-1 min-w-0 cursor-pointer hover:opacity-80"
                      onClick={() => onSelectClaim(claim.id)}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-xs font-bold text-secondary">{claim.claim_number}</span>
                        <Badge
                          variant="outline"
                          className="text-[10px] capitalize rounded-full border-outline-variant text-on-surface-variant"
                        >
                          {claim.status.replace("_", " ")}
                        </Badge>
                        {claim.source === "sor" && (
                          <Badge
                            variant="outline"
                            className="text-[10px] rounded-full border-primary/30 bg-primary/10 text-primary gap-1"
                            title="Synced from System of Record"
                          >
                            <Icon name="cloud_done" size={10} />
                            SOR
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="font-medium text-on-surface flex items-center gap-1.5">
                          <Icon name="person" size={14} className="text-on-surface-variant" />
                          {claim.claimant_name || "Not specified"}
                        </span>
                        {claim.incident_date && (
                          <span className="text-body-md text-on-surface-variant flex items-center gap-1.5">
                            <Icon name="calendar_today" size={14} />
                            {new Date(claim.incident_date).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="text-right flex-shrink-0">
                      <div className="flex items-center gap-1.5 text-on-surface-variant mb-1">
                        <Icon name="description" size={14} />
                        <span className="text-xs">{claim.claim_documents?.length || 0} docs</span>
                      </div>
                      <span className="text-xs text-on-surface-variant">{getTimeAgo(claim.created_at)}</span>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* Phase 2.3 assign-to-me. Mine = filled icon; others'/empty = outlined. */}
                      {type === "pending" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleAssignToMe(claim.id)}
                          disabled={assigningId === claim.id || !user?.id}
                          className={cn(
                            "text-on-surface-variant hover:text-primary",
                            claim.assigned_to === user?.id && "text-primary",
                          )}
                          title={
                            claim.assigned_to === user?.id
                              ? "Assigned to you — click to unassign"
                              : claim.assigned_to
                                ? "Assigned to another reviewer — click to take over"
                                : "Assign to me"
                          }
                        >
                          {assigningId === claim.id ? (
                            <Icon name="progress_activity" size={18} className="animate-spin" />
                          ) : (
                            <Icon
                              name={claim.assigned_to === user?.id ? "person" : "person_add"}
                              size={18}
                              filled={claim.assigned_to === user?.id}
                            />
                          )}
                        </Button>
                      )}

                      <Dialog
                        open={notesDialogOpen === claim.id}
                        onOpenChange={(open) => {
                          if (open) {
                            setEditingNotes(claim.review_notes || "");
                            setNotesDialogOpen(claim.id);
                          } else {
                            setNotesDialogOpen(null);
                          }
                        }}
                      >
                        <DialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "text-on-surface-variant hover:text-primary",
                              claim.review_notes && "text-primary",
                            )}
                          >
                            <Icon name="chat" size={18} />
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Review Notes</DialogTitle>
                            <DialogDescription>
                              Add notes for claim {claim.claim_number}. These notes will accompany the review
                              through the process.
                            </DialogDescription>
                          </DialogHeader>
                          <Textarea
                            value={editingNotes}
                            onChange={(e) => setEditingNotes(e.target.value)}
                            placeholder="Enter review notes..."
                            rows={6}
                          />
                          <DialogFooter>
                            <Button variant="outline" onClick={() => setNotesDialogOpen(null)}>
                              Cancel
                            </Button>
                            <Button onClick={() => handleSaveNotes(claim.id)}>Save Notes</Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>

                      {type === "pending" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleMarkComplete(claim.id, claim.claim_number)}
                          disabled={completingId === claim.id}
                          className="text-on-surface-variant hover:text-success"
                          title="Mark as Complete"
                        >
                          {completingId === claim.id ? (
                            <Icon name="progress_activity" size={18} className="animate-spin" />
                          ) : (
                            <Icon name="check" size={18} />
                          )}
                        </Button>
                      )}

                      {canApproveReject() && claim.status === "in_review" && (
                        <ClaimApprovalActions claimId={claim.id} claimNumber={claim.claim_number} />
                      )}

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-on-surface-variant hover:text-destructive"
                            disabled={isDeleting}
                          >
                            {isDeleting ? (
                              <Icon name="progress_activity" size={18} className="animate-spin" />
                            ) : (
                              <Icon name="delete" size={18} />
                            )}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete Claim</AlertDialogTitle>
                            <AlertDialogDescription>
                              Are you sure you want to delete claim <strong>{claim.claim_number}</strong>? This
                              will also delete all associated documents and analysis. This action cannot be
                              undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDeleteClaim(claim.id, claim.claim_number)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>

                      <Button variant="ghost" size="icon" onClick={() => onSelectClaim(claim.id)}>
                        <Icon name="arrow_forward" size={18} />
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
