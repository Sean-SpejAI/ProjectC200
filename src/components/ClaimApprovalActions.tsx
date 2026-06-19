import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Icon } from "@/components/Icon";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";

interface ClaimApprovalActionsProps {
  claimId: string;
  claimNumber: string;
  onStatusChange?: (newStatus: string) => void;
}

export function ClaimApprovalActions({ claimId, claimNumber, onStatusChange }: ClaimApprovalActionsProps) {
  const { user } = useAuth();
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  const handleApprove = async () => {
    if (!user) return;
    setLoading(true);
    const { error } = await supabase
      .from("claims")
      .update({ status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
      .eq("id", claimId);
    if (error) {
      toast.error("Failed to approve claim");
    } else {
      toast.success(`Claim ${claimNumber} approved`);
      onStatusChange?.("approved");
    }
    setLoading(false);
    setApproveDialogOpen(false);
  };

  const handleReject = async () => {
    if (!user) return;
    setLoading(true);
    const { error } = await supabase
      .from("claims")
      .update({ status: "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
      .eq("id", claimId);
    if (error) {
      toast.error("Failed to reject claim");
    } else {
      toast.success(`Claim ${claimNumber} rejected`);
      onStatusChange?.("rejected");
    }
    setLoading(false);
    setRejectDialogOpen(false);
    setNotes("");
  };

  return (
    <div className="flex items-center gap-2">
      <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="default" size="sm" className="gap-1.5 bg-success hover:bg-success/90">
            <Icon name="check_circle" size={16} filled />
            Approve
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve Claim</DialogTitle>
            <DialogDescription>
              Are you sure you want to approve claim{" "}
              <span className="font-mono font-semibold">{claimNumber}</span>?
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              placeholder="Add approval notes (optional)..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleApprove} disabled={loading} className="bg-success hover:bg-success/90">
              {loading && <Icon name="progress_activity" size={16} className="mr-2 animate-spin" />}
              Confirm Approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="destructive" size="sm" className="gap-1.5">
            <Icon name="cancel" size={16} filled />
            Reject
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Claim</DialogTitle>
            <DialogDescription>
              Are you sure you want to reject claim{" "}
              <span className="font-mono font-semibold">{claimNumber}</span>?
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              placeholder="Reason for rejection (required)..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={loading || !notes.trim()}>
              {loading && <Icon name="progress_activity" size={16} className="mr-2 animate-spin" />}
              Confirm Rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
