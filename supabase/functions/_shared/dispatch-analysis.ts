import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Flag-gated dispatch for document analysis.
//
// When `imageright_settings.staged_analysis_enabled = 'true'`, documents are
// routed into the STAGED pgmq pipeline (one heavy pass per Edge invocation, with
// auto-resplit + dead-letter protection) via the idempotent enqueue RPC.
// Otherwise we fall back to the MONOLITHIC path (the original behavior) — a
// single analyze-claim-document invocation that runs every pass.
//
// The flag is cached briefly per isolate so a cutover/rollback (flipping the
// setting) propagates within ~30 s without a redeploy. On any flag-read error we
// default to the monolith — the proven, safe path.

let _stagedCache: { value: boolean; at: number } | null = null;
const STAGED_TTL_MS = 30_000;

export async function isStagedEnabled(supabase: SupabaseClient): Promise<boolean> {
  const now = Date.now();
  if (_stagedCache && now - _stagedCache.at < STAGED_TTL_MS) return _stagedCache.value;
  try {
    const { data } = await supabase
      .from("imageright_settings")
      .select("value")
      .eq("name", "staged_analysis_enabled")
      .maybeSingle();
    const value = data?.value === "true";
    _stagedCache = { value, at: now };
    return value;
  } catch (err) {
    console.warn(`[dispatchForAnalysis] flag read failed, defaulting to monolith: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// Dispatch one document for analysis. Idempotent on the staged path
// (analyze_stages_enqueue_if_idle only enqueues a doc whose analysis_stage is
// NULL). Never throws — a failed dispatch leaves the doc 'pending' and the
// stuck-pending watchdog re-dispatches it.
export async function dispatchForAnalysis(supabase: SupabaseClient, documentId: string): Promise<void> {
  try {
    if (await isStagedEnabled(supabase)) {
      await supabase.rpc("analyze_stages_enqueue_if_idle", { p_document_id: documentId });
      return;
    }
  } catch (err) {
    console.warn(`[dispatchForAnalysis] staged enqueue failed for ${documentId}, falling back to monolith: ${err instanceof Error ? err.message : err}`);
  }
  // Monolithic fallback (flag off, or staged enqueue errored).
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    const res = await fetch(`${url}/functions/v1/analyze-claim-document`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, async: true }),
    });
    if (!res.ok) {
      console.warn(`[dispatchForAnalysis] HTTP ${res.status} for doc ${documentId}; watchdog will retry`);
    }
  } catch (err) {
    console.warn(`[dispatchForAnalysis] network error for doc ${documentId}: ${err instanceof Error ? err.message : err}`);
  }
}
