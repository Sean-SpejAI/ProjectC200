// Approve (or reject) a held ImageRight reconcile for a human-edited claim.
//
// When ImageRight data changes on a claim whose analysis a reviewer has edited,
// pullClaim parks the change (claims.synthesis_status='awaiting_approval' +
// pending_reconcile). This endpoint lets an admin / claims manager decide:
//
//   { claimId, approved: true }  -> re-run the reconcile (approvedReconcile=true),
//                                   which applies incremental/full + clears the
//                                   held markers + re-fires synthesis.
//   { claimId, approved: false } -> dismiss: clear pending_reconcile, restore
//                                   synthesis_status='completed' (edits + the
//                                   human-edit flag are kept, so a later change
//                                   is gated again).
//
// Auth: caller must hold the 'admin' or 'claims_manager' role.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
// Pin the SAME supabase-js major as the _shared modules so the SupabaseClient
// type we pass to loadReconcileThresholds matches.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";
import { pullClaim, loadReconcileThresholds } from "../_shared/imageright-pull-claim.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "X-Content-Type-Options": "nosniff",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse(401, { error: "unauthorized" });

    const body = await req.json().catch(() => ({}));
    const claimId = (body?.claimId as string | undefined)?.trim() || undefined;
    const approved = body?.approved === true;
    if (!claimId) return jsonResponse(400, { error: "missing_claimId" });

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return jsonResponse(401, { error: "unauthorized" });
    const userId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Authorize: admin or claims_manager (same as approve/reject claims).
    const { data: roleRows, error: roleErr } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .in("role", ["admin", "claims_manager"]);
    if (roleErr) throw roleErr;
    if (!roleRows || roleRows.length === 0) return jsonResponse(403, { error: "forbidden" });

    const scannerEarly = scannerShortCircuit(req, corsHeaders);
    if (scannerEarly) return scannerEarly;

    const { data: claim, error: claimErr } = await admin
      .from("claims")
      .select("id, imageright_file_id, pending_reconcile, synthesis_status")
      .eq("id", claimId)
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claim) return jsonResponse(404, { error: "claim_not_found" });
    if (!claim.pending_reconcile) return jsonResponse(400, { error: "no_pending_reconcile" });

    // Reject → dismiss the held reconcile; keep edits + the human-edit flag.
    // Restore the pre-hold synthesis_status (captured when the gate fired) rather
    // than hard-coding 'completed' — a failed/skipped/not_run claim shouldn't be
    // forced to look completed.
    if (!approved) {
      const priorStatus = (claim.pending_reconcile as { prior_synthesis_status?: string } | null)
        ?.prior_synthesis_status ?? "completed";
      await admin
        .from("claims")
        .update({ pending_reconcile: null, synthesis_status: priorStatus })
        .eq("id", claimId);
      return jsonResponse(200, { approved: false, status: "dismissed" });
    }

    // Approve → re-run the reconcile, bypassing the human-edit gate. Thread in the
    // mode the reviewer approved so pullClaim can RE-HOLD if the change grew more
    // destructive since approval (consent guard).
    if (!claim.imageright_file_id) return jsonResponse(400, { error: "claim_not_synced" });
    const fileId = Number(claim.imageright_file_id);
    const approvedMode = (claim.pending_reconcile as { mode?: "incremental" | "full" } | null)?.mode;
    const thresholds = await loadReconcileThresholds(admin);

    const { data: run } = await admin
      .from("imageright_sync_runs")
      .insert({
        run_type: "manual_reload",
        triggered_by: userId,
        status: "running",
        notes: `approved_reconcile claim_id=${claimId} file_id=${fileId}`,
      })
      .select("id")
      .single();
    const runId = run?.id ?? crypto.randomUUID();

    // Apply in the background (a 'full' reconcile re-pulls everything and can
    // exceed the 150s gateway). The UI polls synthesis_status.
    EdgeRuntime.waitUntil((async () => {
      try {
        const result = await pullClaim(fileId, {
          runId,
          reconcile: true,
          approvedReconcile: true,
          approvedMode,
          reconcileThresholds: thresholds,
          triggeredBy: userId,
        });
        if (run?.id) {
          await admin
            .from("imageright_sync_runs")
            .update({
              status: result.status === "failed" ? "failed" : "completed",
              completed_at: new Date().toISOString(),
              claims_found: 1,
            })
            .eq("id", run.id);
        }
      } catch (e) {
        console.error("[approve-reconcile] apply failed:", e instanceof Error ? e.message : String(e));
      }
    })());

    return jsonResponse(202, { approved: true, status: "applying" });
  } catch (e) {
    return jsonResponse(500, { error: e instanceof Error ? e.message : String(e) });
  }
});
