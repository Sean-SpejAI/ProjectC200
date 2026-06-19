// Persist a reviewer's edits to a claim's AI analysis (claims.ai_synthesis) and
// record a field-level audit trail of what changed.
//
// Body: { claimId: "<uuid>", aiSynthesis: <object> }
//
// On save we deep-diff the submitted analysis against the stored one, write one
// claim_field_audit row per changed leaf field (changed_by = the user, kind =
// 'human'), persist the new ai_synthesis, set status='in_review', and stamp
// synthesis_human_edited_at/by — which is the signal that gates ImageRight
// reconciliation (it must wait for approval once a human has edited).
//
// Auth: caller must be authenticated AND hold a staff role (admin /
// claims_manager / claims_reviewer). Writes use the service role.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";
import { diffAnalysis } from "../_shared/analysis-diff.ts";

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

const STAFF_ROLES = ["admin", "claims_manager", "claims_reviewer"];

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
    const aiSynthesis = body?.aiSynthesis;
    if (!claimId) return jsonResponse(400, { error: "missing_claimId" });
    // Must be a plain object — reject null, primitives, and arrays (typeof []
    // is "object", so guard explicitly) to avoid clobbering ai_synthesis with a
    // non-object shape the rest of the pipeline doesn't expect.
    if (aiSynthesis == null || typeof aiSynthesis !== "object" || Array.isArray(aiSynthesis)) {
      return jsonResponse(400, { error: "invalid_aiSynthesis" });
    }

    // Authenticate caller
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return jsonResponse(401, { error: "unauthorized" });
    const userId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Authorize: caller must hold a staff role.
    const { data: roleRows, error: roleErr } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .in("role", STAFF_ROLES);
    if (roleErr) throw roleErr;
    if (!roleRows || roleRows.length === 0) return jsonResponse(403, { error: "forbidden" });
    const roles = new Set((roleRows ?? []).map((r) => r.role as string));
    const elevated = roles.has("admin") || roles.has("claims_manager");

    const scannerEarly = scannerShortCircuit(req, corsHeaders);
    if (scannerEarly) return scannerEarly;

    // Read the stored analysis to diff against (+ ownership for scope check).
    const { data: claim, error: claimErr } = await admin
      .from("claims")
      .select("id, ai_synthesis, assigned_to")
      .eq("id", claimId)
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claim) return jsonResponse(404, { error: "claim_not_found" });

    // Scope: admins/managers may edit any claim; a plain claims_reviewer may only
    // edit a claim assigned to them (mirrors the claims-table UPDATE RLS policy
    // `assigned_to = auth.uid() OR admin OR claims_manager`, which the service-role
    // client here would otherwise bypass).
    if (!elevated && claim.assigned_to !== userId) {
      return jsonResponse(403, { error: "forbidden_not_assigned" });
    }

    const changes = diffAnalysis(claim.ai_synthesis ?? {}, aiSynthesis);

    // Record the audit rows (only when something actually changed).
    if (changes.length > 0) {
      const rows = changes.map((c) => ({
        claim_id: claimId,
        field_path: c.path,
        field_label: c.label,
        old_value: c.old ?? null,
        new_value: c.new ?? null,
        changed_by: userId,
        changed_by_kind: "human" as const,
      }));
      const { error: auditErr } = await admin.from("claim_field_audit").insert(rows);
      if (auditErr) throw auditErr;
    }

    // Persist. On a no-op save (no field changed) DON'T rewrite ai_synthesis —
    // that would risk clobbering a concurrent AI synthesis with a stale client
    // snapshot, and there's nothing to persist. Only stamp the human-edit signal
    // (which gates reconciliation) when a real change occurred.
    const update: Record<string, unknown> = {
      status: "in_review",
      updated_at: new Date().toISOString(),
    };
    if (changes.length > 0) {
      update.ai_synthesis = aiSynthesis;
      update.synthesis_human_edited_at = new Date().toISOString();
      update.synthesis_human_edited_by = userId;
    }
    const { error: updErr } = await admin.from("claims").update(update).eq("id", claimId);
    if (updErr) throw updErr;

    return jsonResponse(200, { saved: true, changes: changes.length });
  } catch (e) {
    return jsonResponse(500, { error: e instanceof Error ? e.message : String(e) });
  }
});
