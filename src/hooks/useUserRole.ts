import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

type AppRole = "admin" | "claims_manager" | "claims_reviewer";

export function useUserRole() {
  const { user, loading: authLoading } = useAuth();
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [loading, setLoading] = useState(true);
  // Once we've resolved roles at least once for the current user, never flip
  // back to loading=true on subsequent re-checks. ProtectedRoute mounts a
  // global spinner whenever rolesLoading is true, which unmounts Index —
  // and that wipes claimContext on tab refocus. Same pattern fix as
  // useMFAStatus.ts (PR #76).
  const hasResolvedRef = useRef(false);

  useEffect(() => {
    // While auth is still settling, keep `loading=true` so consumers can't
    // race-fire access-denied logic against a null user.
    if (authLoading) {
      if (!hasResolvedRef.current) setLoading(true);
      return;
    }

    if (!user) {
      setRoles([]);
      hasResolvedRef.current = false;
      setLoading(false);
      return;
    }

    let cancelled = false;
    if (!hasResolvedRef.current) setLoading(true);

    (async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);

      if (cancelled) return;

      if (error) {
        console.error("Error fetching user roles:", error);
        setRoles([]);
      } else {
        setRoles(data?.map((r: any) => r.role) || []);
      }
      hasResolvedRef.current = true;
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user, authLoading]);

  const hasRole = (role: AppRole) => roles.includes(role);
  const isAdmin = () => hasRole("admin");
  const isClaimsManager = () => hasRole("claims_manager");
  const isClaimsReviewer = () => hasRole("claims_reviewer");
  const canApproveReject = () => isAdmin() || isClaimsManager();
  const canManageUsers = () => isAdmin();

  return {
    roles,
    loading,
    hasRole,
    isAdmin,
    isClaimsManager,
    isClaimsReviewer,
    canApproveReject,
    canManageUsers,
  };
}
