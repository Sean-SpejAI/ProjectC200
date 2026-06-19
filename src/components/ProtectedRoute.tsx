import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useMFAStatus } from "@/hooks/useMFAStatus";
import { useUserRole } from "@/hooks/useUserRole";
import { Icon } from "@/components/Icon";
import { MFAEnrollGate } from "@/components/MFAEnrollGate";
import { MFAVerify } from "@/components/MFAVerify";
import { PendingApprovalGate } from "@/components/PendingApprovalGate";
import { supabase } from "@/integrations/supabase/client";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading: authLoading } = useAuth();
  const { loading: mfaLoading, needsEnroll, needsVerify, refresh } = useMFAStatus();
  const { roles, loading: rolesLoading } = useUserRole();
  const navigate = useNavigate();

  // Once we start the enrollment gate, keep it mounted until the user
  // acknowledges their backup codes — even if `needsEnroll` flips to false
  // mid-flow (verifying the TOTP code elevates the session to AAL2 instantly,
  // which would otherwise unmount us and skip the backup-codes screen).
  const [enrollGateLocked, setEnrollGateLocked] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (needsEnroll) setEnrollGateLocked(true);
  }, [needsEnroll]);

  // Reset the lock when the user signs out (so a fresh sign-in starts fresh).
  useEffect(() => {
    if (!user) setEnrollGateLocked(false);
  }, [user]);

  // Keep MFAEnrollGate mounted even during loading flickers — verifying the
  // TOTP elevates the session to AAL2, which fires onAuthStateChange and
  // briefly flips useMFAStatus into loading. If we unmount the gate here,
  // MFAEnrollGate loses its stage state and the user lands back on the
  // "2FA is enabled" view instead of seeing their backup codes.
  if (enrollGateLocked && user) {
    return (
      <MFAEnrollGate
        onComplete={() => {
          setEnrollGateLocked(false);
          refresh();
        }}
      />
    );
  }

  if (authLoading || mfaLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Icon name="progress_activity" size={32} className="animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  if (needsVerify) {
    return (
      <MFAVerify
        onSuccess={refresh}
        onCancel={async () => {
          await supabase.auth.signOut();
        }}
      />
    );
  }

  if (rolesLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Icon name="progress_activity" size={32} className="animate-spin text-primary" />
      </div>
    );
  }

  if (roles.length === 0) {
    return <PendingApprovalGate />;
  }

  return <>{children}</>;
}
