import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export interface MFAStatus {
  loading: boolean;
  hasFactor: boolean;
  isAAL2: boolean;
  needsEnroll: boolean;
  needsVerify: boolean;
  refresh: () => void;
}

export function useMFAStatus(): MFAStatus {
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [hasFactor, setHasFactor] = useState(false);
  const [isAAL2, setIsAAL2] = useState(false);
  const [tick, setTick] = useState(0);
  // Once we've resolved MFA state at least once for the current user, never
  // flip back to loading=true on subsequent re-checks. ProtectedRoute mounts
  // the global Loading spinner whenever mfaLoading is true, which unmounts
  // the entire Index page — and that's what was wiping claimContext on tab
  // refocus (TOKEN_REFRESHED → tick++ → spinner → remount).
  const hasResolvedRef = useRef(false);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (authLoading) {
      if (!hasResolvedRef.current) setLoading(true);
      return;
    }
    if (!user) {
      setHasFactor(false);
      setIsAAL2(false);
      hasResolvedRef.current = false;
      setLoading(false);
      return;
    }

    let cancelled = false;
    if (!hasResolvedRef.current) setLoading(true);

    (async () => {
      const [factorsRes, aalRes] = await Promise.all([
        supabase.auth.mfa.listFactors(),
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      ]);
      if (cancelled) return;

      const verified = factorsRes.data?.totp?.some((f) => f.status === "verified") ?? false;
      setHasFactor(verified);

      const cur = aalRes.data?.currentLevel ?? null;
      setIsAAL2(cur === "aal2");

      hasResolvedRef.current = true;
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user, authLoading, tick]);

  // Re-evaluate only on events that actually change MFA state. Skipping
  // TOKEN_REFRESHED / INITIAL_SESSION / USER_UPDATED is intentional — those
  // fire on tab refocus and would otherwise retrigger the outer effect,
  // briefly flipping mfaLoading=true and remounting the whole app.
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (
        event === "SIGNED_IN" ||
        event === "SIGNED_OUT" ||
        event === "MFA_CHALLENGE_VERIFIED"
      ) {
        refresh();
      }
    });
    return () => subscription.unsubscribe();
  }, [refresh]);

  return {
    loading,
    hasFactor,
    isAAL2,
    needsEnroll: !loading && !!user && !hasFactor,
    needsVerify: !loading && !!user && hasFactor && !isAAL2,
    refresh,
  };
}
