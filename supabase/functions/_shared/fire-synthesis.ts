import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Lock-first claim-level synthesis trigger.
//
// CAS-acquires the claim's synthesis lock (only from a not-yet-running state) and
// fires synthesize-claim-extraction ONLY when no sibling document is still
// pending/processing — otherwise it releases the lock so the truly-last sibling
// fires it. Soft-removed docs are excluded from the in-flight check.
//
// Shared by:
//   - analyze-claim-document: a document just finished its final stage.
//   - imageright-pull-claim:  a reconcile run that ONLY removed documents —
//     nothing is dispatched to analyze, so synthesis must be kicked explicitly
//     to drop the removed docs' extractions from the claim summary.
//
// Never throws.
export async function maybeFireSynthesis(
  supabase: SupabaseClient,
  claimId: string,
): Promise<void> {
  try {
    const { data: locked } = await supabase
      .from("claims")
      .update({ synthesis_status: "running" })
      .eq("id", claimId)
      .in("synthesis_status", ["not_run", "pending"])
      .select("id");
    if (!locked || locked.length === 0) return; // lost race / already running/done

    const { data: siblings } = await supabase
      .from("claim_documents")
      .select("processing_status")
      .eq("claim_id", claimId)
      .is("imageright_removed_at", null);
    const inFlight = (siblings ?? []).filter(
      (s) => s.processing_status === "pending" || s.processing_status === "processing",
    );

    if (inFlight.length === 0) {
      const url = Deno.env.get("SUPABASE_URL");
      const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (url && key) {
        await fetch(`${url}/functions/v1/synthesize-claim-extraction`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ claimId }),
        }).catch(() => {});
      }
    } else {
      // Acquired too early — release so the truly-last sibling can fire it.
      await supabase.from("claims").update({ synthesis_status: "not_run" }).eq("id", claimId);
    }
  } catch {
    /* best-effort; the stuck-pending watchdog is the backstop */
  }
}
