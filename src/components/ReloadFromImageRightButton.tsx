import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
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
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface ReloadFromImageRightButtonProps {
  claimId: string;
  claimNumber?: string;
  onReloadStarted?: (runId: string) => void;
}

// Admin-only control. Wipes the claim's local state (manual + IR-sourced
// docs, AI analysis, claim details edits) and re-pulls everything from
// ImageRight. Surface a hard confirmation before invoking.
export function ReloadFromImageRightButton({ claimId, claimNumber, onReloadStarted }: ReloadFromImageRightButtonProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("reload-claim-from-imageright", {
        body: { claimId },
      });
      if (error) throw error;
      const runId = (data as { runId?: string })?.runId;
      toast({
        title: "Reload from ImageRight started",
        description: `Re-pulling claim ${claimNumber ?? claimId} in the background.`,
      });
      if (runId) onReloadStarted?.(runId);
      setOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast({
        title: "Reload failed to start",
        description: message,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="gap-2 text-on-surface-variant"
        onClick={() => setOpen(true)}
      >
        <Icon name="cloud_download" size={18} />
        <span className="text-label-md hidden md:inline">Reload from ImageRight</span>
      </Button>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reload this claim from ImageRight?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                This will permanently delete all current documents and AI analysis for claim{" "}
                <span className="font-mono font-semibold">{claimNumber ?? claimId}</span>, then
                re-pull everything from ImageRight.
              </span>
              <span className="block">
                Any manually-uploaded documents and edits to claim details will be lost.
                This cannot be undone.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={submitting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {submitting ? "Starting..." : "Reload from ImageRight"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
