import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Icon } from "@/components/Icon";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type RunType = "one_time" | "daily_diff" | "manual_reload";
type RunStatus = "running" | "completed" | "failed" | "partial";

interface SyncRun {
  id: string;
  run_type: RunType;
  window_from: string | null;
  window_to: string | null;
  started_at: string;
  completed_at: string | null;
  status: RunStatus;
  claims_found: number;
  claims_synced: number;
  documents_created: number;
  documents_pending_content: number;
  errors: Array<{ stage: string; message: string; retryable?: boolean; claim_number?: string | null; at?: string }>;
  notes: string | null;
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

function statusVariant(status: RunStatus): "default" | "destructive" | "outline" | "secondary" {
  switch (status) {
    case "completed": return "default";
    case "partial":   return "secondary";
    case "failed":    return "destructive";
    default:          return "outline";
  }
}

export function SorSyncPanel() {
  const [mode, setMode] = useState<"daily_diff" | "one_time">("daily_diff");
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);

  const [claimNumberInput, setClaimNumberInput] = useState("");
  const [pullingByNumber, setPullingByNumber] = useState(false);
  const [confirmPullOpen, setConfirmPullOpen] = useState(false);

  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const hasRunningRow = useMemo(() => runs.some((r) => r.status === "running"), [runs]);

  const loadRuns = useCallback(async () => {
    // Cast: sor_sync_runs lands in Database types after the next type regen
    // (run `npx supabase gen types typescript` against Dev once the migration applies).
    type SyncBuilder = {
      select: (cols: string) => SyncBuilder;
      order: (col: string, opts: { ascending: boolean }) => SyncBuilder;
      limit: (n: number) => Promise<{ data: SyncRun[] | null; error: unknown }>;
    };
    type SyncCapableClient = { from: (table: string) => SyncBuilder };
    const { data, error } = await (supabase as unknown as SyncCapableClient)
      .from("sor_sync_runs")
      .select("id, run_type, window_from, window_to, started_at, completed_at, status, claims_found, claims_synced, documents_created, documents_pending_content, errors, notes")
      .order("started_at", { ascending: false })
      .limit(20);
    if (error) {
      console.error("Failed to load sync runs", error);
      return;
    }
    setRuns(data ?? []);
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!hasRunningRow) return;
    const t = setInterval(loadRuns, 5000);
    return () => clearInterval(t);
  }, [hasRunningRow, loadRuns]);

  const startSync = async () => {
    setSubmitting(true);
    try {
      const body = mode === "daily_diff" ? { run_type: "daily_diff" } : { run_type: "one_time", from, to };
      const { error } = await supabase.functions.invoke("sor-sync", { body });
      if (error) throw error;
      toast.success(`${mode === "daily_diff" ? "Daily diff" : "One-time load"} started`);
      await loadRuns();
    } catch (err) {
      toast.error(`Failed to start sync: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSubmitting(false);
    }
  };

  const trimmedClaimNumber = claimNumberInput.trim();

  const pullOneClaim = async () => {
    setPullingByNumber(true);
    try {
      const { data, error } = await supabase.functions.invoke("reload-claim-from-sor", {
        body: { claimNumber: trimmedClaimNumber },
      });
      if (error) throw error;
      const runId = (data as { runId?: string })?.runId;
      toast.success(`Pulling claim ${trimmedClaimNumber} from System of Record`, {
        description: runId ? `Run ${runId.slice(0, 8)}… — watch the table below for status.` : undefined,
      });
      setClaimNumberInput("");
      setConfirmPullOpen(false);
      await loadRuns();
    } catch (err) {
      toast.error(`Failed to pull claim: ${err instanceof Error ? err.message : err}`);
    } finally {
      setPullingByNumber(false);
    }
  };

  return (
    <div className="space-y-6 mt-10">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-secondary-container text-on-secondary-container flex items-center justify-center">
          <Icon name="cloud_sync" size={20} filled />
        </div>
        <div>
          <h2 className="text-headline-md text-primary">System of Record Sync</h2>
          <p className="text-body-md text-on-surface-variant">Pull claims and documents from System of Record</p>
        </div>
      </div>

      {/* Card 1 — Run a sync */}
      <Card className="bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl p-6">
        <h3 className="text-title-md mb-4">Run a sync</h3>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="sync-mode"
                value="daily_diff"
                checked={mode === "daily_diff"}
                onChange={() => setMode("daily_diff")}
              />
              <span className="text-body-md">Daily diff (now)</span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="sync-mode"
                value="one_time"
                checked={mode === "one_time"}
                onChange={() => setMode("one_time")}
              />
              <span className="text-body-md">One-time load by date range</span>
            </label>
          </div>
          {mode === "one_time" && (
            <div className="flex items-center gap-2">
              <div>
                <label className="block text-xs text-on-surface-variant mb-1">From</label>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9" />
              </div>
              <div>
                <label className="block text-xs text-on-surface-variant mb-1">To</label>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9" />
              </div>
            </div>
          )}
          <Button onClick={startSync} disabled={submitting || hasRunningRow}>
            {submitting ? "Starting..." : hasRunningRow ? "A sync is running" : "Start sync"}
          </Button>
        </div>
        <p className="text-xs text-on-surface-variant mt-3">
          Both modes filter by System of Record's <code className="font-mono">DateModified</code> — daily diff covers the last 36 hours, one-time covers the chosen window. One-time loads slice into ~30-day chunks and resume across multiple edge function invocations.
        </p>
      </Card>

      {/* Card 2 — Pull one claim by number */}
      <Card className="bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl p-6">
        <h3 className="text-title-md mb-2">Pull one claim</h3>
        <p className="text-body-md text-on-surface-variant mb-4">
          Enter a claim number (e.g. <code className="font-mono">0000372262</code>) to pull that single claim and all of its documents from System of Record now. If the claim already exists locally, its documents and AI analysis are wiped and re-pulled.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grow max-w-xs">
            <label className="block text-xs text-on-surface-variant mb-1">Claim number</label>
            <Input
              value={claimNumberInput}
              onChange={(e) => setClaimNumberInput(e.target.value)}
              placeholder="0000372262"
              className="h-9 font-mono"
              disabled={pullingByNumber}
            />
          </div>
          <Button
            onClick={() => setConfirmPullOpen(true)}
            disabled={pullingByNumber || trimmedClaimNumber.length === 0}
          >
            {pullingByNumber ? "Pulling..." : "Pull from System of Record"}
          </Button>
        </div>
      </Card>

      <AlertDialog open={confirmPullOpen} onOpenChange={(open) => !pullingByNumber && setConfirmPullOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pull claim <span className="font-mono">{trimmedClaimNumber}</span> from System of Record?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                If this claim already exists locally, all of its current documents and AI analysis will be permanently deleted, then everything will be re-pulled from System of Record.
              </span>
              <span className="block">
                Any manually-uploaded documents and edits to claim details will be lost. This cannot be undone.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pullingByNumber}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={pullOneClaim}
              disabled={pullingByNumber}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pullingByNumber ? "Pulling..." : "Pull from System of Record"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Card 3 — Recent runs */}
      <Card className="bg-surface-container-lowest border-outline-variant shadow-elevation-1 rounded-2xl overflow-hidden">
        <div className="p-6 pb-3 flex items-center justify-between">
          <h3 className="text-title-md">Recent runs</h3>
          <Button variant="ghost" size="sm" onClick={loadRuns}>
            <Icon name="refresh" size={16} className="mr-1.5" />
            Refresh
          </Button>
        </div>
        {runs.length === 0 ? (
          <div className="px-6 pb-6 text-body-md text-on-surface-variant">No sync runs yet.</div>
        ) : (
          <div className="border-t border-outline-variant overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-container-low/50">
                <tr>
                  <th className="text-left px-4 py-3 text-label-md uppercase tracking-widest text-on-surface-variant">Started</th>
                  <th className="text-left px-4 py-3 text-label-md uppercase tracking-widest text-on-surface-variant">Type</th>
                  <th className="text-left px-4 py-3 text-label-md uppercase tracking-widest text-on-surface-variant">Window</th>
                  <th className="text-left px-4 py-3 text-label-md uppercase tracking-widest text-on-surface-variant">Status</th>
                  <th className="text-right px-4 py-3 text-label-md uppercase tracking-widest text-on-surface-variant">Found</th>
                  <th className="text-right px-4 py-3 text-label-md uppercase tracking-widest text-on-surface-variant">Synced</th>
                  <th className="text-right px-4 py-3 text-label-md uppercase tracking-widest text-on-surface-variant">Docs</th>
                  <th className="text-right px-4 py-3 text-label-md uppercase tracking-widest text-on-surface-variant">Pending</th>
                  <th className="text-right px-4 py-3 text-label-md uppercase tracking-widest text-on-surface-variant">Errors</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const isExpanded = expandedId === run.id;
                  return (
                    <>
                      <tr
                        key={run.id}
                        className="border-t border-outline-variant cursor-pointer hover:bg-surface-container-low"
                        onClick={() => setExpandedId(isExpanded ? null : run.id)}
                      >
                        <td className="px-4 py-3 font-mono text-xs">{fmtDate(run.started_at)}</td>
                        <td className="px-4 py-3 capitalize">{run.run_type.replace("_", " ")}</td>
                        <td className="px-4 py-3 text-xs font-mono">
                          {run.window_from ? fmtDate(run.window_from).slice(0, 10) : "—"} → {run.window_to ? fmtDate(run.window_to).slice(0, 10) : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={statusVariant(run.status)} className="capitalize">{run.status}</Badge>
                        </td>
                        <td className="px-4 py-3 text-right">{run.claims_found}</td>
                        <td className="px-4 py-3 text-right">{run.claims_synced}</td>
                        <td className="px-4 py-3 text-right">{run.documents_created}</td>
                        <td className="px-4 py-3 text-right">{run.documents_pending_content}</td>
                        <td className="px-4 py-3 text-right">
                          {run.errors?.length ? (
                            <span className="text-destructive font-semibold">{run.errors.length}</span>
                          ) : (
                            <span className="text-on-surface-variant">0</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-surface-container-low/30">
                          <td colSpan={9} className="px-4 py-3">
                            {run.notes && <div className="text-xs mb-2"><span className="text-on-surface-variant">Notes:</span> {run.notes}</div>}
                            {run.errors?.length ? (
                              <div className="space-y-1">
                                <div className="text-xs uppercase tracking-widest text-on-surface-variant">Errors</div>
                                <ul className="text-xs font-mono space-y-1 max-h-64 overflow-y-auto">
                                  {run.errors.map((e, i) => (
                                    <li key={i} className="border-l-2 border-destructive/40 pl-2">
                                      <span className="text-on-surface-variant">[{e.stage}]</span>{" "}
                                      {e.claim_number ? <span className="text-secondary">{e.claim_number}</span> : null} {e.message}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : (
                              <div className="text-xs text-on-surface-variant">No errors recorded.</div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
