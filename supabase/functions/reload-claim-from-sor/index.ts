// Admin-triggered "pull from Sor" for a single claim. Two entry shapes:
//
//   { claimId: "<uuid>" }           — refresh an existing sor-sourced
//                                     claim by its Supabase row id.
//   { claimNumber: "0000372262" }   — pull a claim by its Sor claim
//                                     number; resolves to fileId via SOAP
//                                     FindFilesEx then runs the same flow.
//                                     Used by the admin "Pull one claim" UI
//                                     to import claims that don't exist yet.
//
// Either way the per-claim worker wipes the claim's existing documents +
// analysis state (isReload=true) and re-pulls. The frontend warns the user
// this is destructive before invoking.
//
// Auth: caller must have the 'admin' role (same pattern as admin-user-actions).

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { pullClaim, resolveFileIdByClaimNumber } from "../_shared/sor-pull-claim.ts";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";

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
    const claimNumber = (body?.claimNumber as string | undefined)?.trim() || undefined;
    if (!claimId && !claimNumber) {
      return jsonResponse(400, { error: "missing_claimId_or_claimNumber" });
    }
    if (claimId && claimNumber) {
      return jsonResponse(400, { error: "provide_exactly_one_of_claimId_or_claimNumber" });
    }

    // Authenticate caller
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return jsonResponse(401, { error: "unauthorized" });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Authorize via service-role role check
    const { data: roleRow, error: roleErr } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (roleErr) throw roleErr;
    if (!roleRow) return jsonResponse(403, { error: "forbidden" });

    // Scanner short-circuit (after admin auth so ZAP still exercises authz).
    const scannerEarly = scannerShortCircuit(req, corsHeaders);
    if (scannerEarly) return scannerEarly;

    // Resolve to an Sor fileId — either from an existing claim row
    // or from a claim-number lookup against the SOAP proxy.
    let sorFileId: number;
    let existingClaimId: string | null = null;

    if (claimId) {
      const { data: claim, error: claimErr } = await admin
        .from("claims")
        .select("id, source, sor_file_id")
        .eq("id", claimId)
        .single();
      if (claimErr || !claim) return jsonResponse(404, { error: "claim_not_found" });
      if (!claim.sor_file_id) return jsonResponse(400, { error: "claim_not_synced" });
      sorFileId = Number(claim.sor_file_id);
      existingClaimId = claim.id;
    } else {
      // claimNumber path — resolve via proxy
      let resolved: number | null;
      try {
        resolved = await resolveFileIdByClaimNumber(claimNumber!);
      } catch (err) {
        return jsonResponse(502, {
          error: "sor_lookup_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (resolved == null) {
        return jsonResponse(404, { error: "claim_number_not_found_in_sor" });
      }
      sorFileId = resolved;
      // The claim row may or may not exist locally; pullClaim handles both.
      const { data: existing } = await admin
        .from("claims")
        .select("id")
        .eq("sor_file_id", sorFileId)
        .maybeSingle();
      existingClaimId = existing?.id ?? null;
    }

    // Create a manual_reload sync_run + single task for traceability
    const { data: run, error: runErr } = await admin
      .from("sor_sync_runs")
      .insert({
        run_type: "manual_reload",
        triggered_by: userData.user.id,
        status: "running",
        notes: claimNumber
          ? `claim_number=${claimNumber} file_id=${sorFileId}`
          : `claim_id=${existingClaimId} file_id=${sorFileId}`,
      })
      .select("id")
      .single();
    if (runErr || !run) throw new Error(`run_insert_failed: ${runErr?.message}`);

    await admin.from("sor_sync_tasks").insert({
      run_id: run.id,
      sor_file_id: sorFileId,
      claim_id: existingClaimId,
      status: "running",
      attempts: 1,
    });

    // Kick the pull in the background; respond 202 so the UI can poll.
    EdgeRuntime.waitUntil((async () => {
      try {
        const result = await pullClaim(sorFileId, {
          runId: run.id,
          isReload: true,
          triggeredBy: userData.user.id,
        });
        const taskStatus = result.status === "succeeded" || result.status === "content_pending" ? "succeeded" : "failed";
        await admin
          .from("sor_sync_tasks")
          .update({
            status: taskStatus,
            claim_id: result.claim_id,
            last_error: result.errors.length > 0 ? result.errors[result.errors.length - 1].message : null,
          })
          .eq("run_id", run.id);

        if (result.errors.length > 0) {
          await admin
            .from("sor_sync_runs")
            .update({
              errors: result.errors.map((e) => ({
                stage: e.stage, message: e.message, retryable: e.retryable, claim_id: result.claim_id, at: new Date().toISOString(),
              })),
            })
            .eq("id", run.id);
        }
        await admin
          .from("sor_sync_runs")
          .update({
            status: result.status === "failed" ? "failed" : (result.errors.length > 0 ? "partial" : "completed"),
            completed_at: new Date().toISOString(),
            claims_found: 1,
            claims_synced: result.status === "failed" ? 0 : 1,
            documents_created: result.docs_created,
            documents_pending_content: result.docs_pending_content,
          })
          .eq("id", run.id);
      } catch (err) {
        console.error("[reload-claim-from-sor] background pull failed", err);
        await admin
          .from("sor_sync_runs")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            errors: [{ stage: "background_exception", message: err instanceof Error ? err.message : String(err), at: new Date().toISOString() }],
          })
          .eq("id", run.id);
      }
    })());

    return jsonResponse(202, {
      success: true,
      runId: run.id,
      claimId: existingClaimId,
      sorFileId,
    });
  } catch (err: any) {
    console.error("reload-claim-from-sor error:", err);
    return jsonResponse(500, { error: err?.message || "internal_error" });
  }
});
