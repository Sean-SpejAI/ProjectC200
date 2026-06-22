// Admin-only "Reset Environment" for the demo.
//
// Three actions (POST body { action }):
//   - "status"  : current claims/documents/storage counts vs. the active
//                 baseline. Drives the Admin-panel card.
//   - "reset"   : restore the latest captured baseline — wipes any demo-session
//                 changes (most importantly a demand packet a presenter uploaded
//                 live) and reseeds the exact baseline claims + documents, then
//                 deletes the demo-time storage objects through the Storage API.
//   - "capture" : snapshot the CURRENT environment as the new baseline. Setup /
//                 re-baseline action (e.g. after the source documents are
//                 replaced). Behind a confirm in the UI since it overwrites the
//                 reset target.
//
// The heavy lifting lives in SECURITY DEFINER SQL functions
// (reset_demo_environment / capture_demo_baseline / demo_reset_status) that are
// granted to service_role only. This function authenticates the caller via
// their JWT, confirms the 'admin' role with the service-role client, and then
// invokes those RPCs with the service-role key.
//
// verify_jwt stays at the platform default (true): this is a user-facing
// endpoint called from the browser with the admin's JWT (same as
// admin-user-actions). We also re-check the session + admin role in-function.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "X-Content-Type-Options": "nosniff",
};

type Action = "status" | "reset" | "capture";
const VALID_ACTIONS: Action[] = ["status", "reset", "capture"];

// Supabase Storage .remove() takes an array; chunk large delete lists.
const REMOVE_CHUNK = 100;
const BUCKET = "claim-documents";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse(401, { error: "unauthorized" });

    let body: { action?: string; note?: string } = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const action = body?.action as Action | undefined;
    if (!action || !VALID_ACTIONS.includes(action)) {
      return jsonResponse(400, { error: "invalid_action" });
    }

    // Authenticate the caller via their JWT.
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return jsonResponse(401, { error: "unauthorized" });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Authorize: must hold the 'admin' role (service-role check bypasses RLS).
    const { data: roleRow, error: roleErr } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (roleErr) throw roleErr;
    if (!roleRow) return jsonResponse(403, { error: "forbidden" });

    if (action === "status") {
      const { data, error } = await admin.rpc("demo_reset_status");
      if (error) throw error;
      return jsonResponse(200, { success: true, status: data });
    }

    if (action === "capture") {
      const note = (body?.note ?? "").toString().trim() || null;
      const { data, error } = await admin.rpc("capture_demo_baseline", {
        p_note: note,
        p_captured_by: userData.user.id,
      });
      if (error) throw error;
      return jsonResponse(200, { success: true, captured: data });
    }

    // action === "reset"
    const { data: resetData, error: resetErr } = await admin.rpc("reset_demo_environment");
    if (resetErr) {
      // Surface the "no baseline captured" case as a clean 409.
      const msg = resetErr.message || "reset_failed";
      if (/no_baseline_captured/.test(msg)) {
        return jsonResponse(409, {
          error: "no_baseline_captured",
          message: "No baseline has been captured yet. Capture one before resetting.",
        });
      }
      throw resetErr;
    }

    // The DB reset reseeds claims/documents and returns the storage objects that
    // are NOT part of the baseline (demo-time uploads). Remove those through the
    // Storage API so the backing files are actually deleted (deleting
    // storage.objects rows in SQL would orphan the files).
    const extraKeys: string[] = Array.isArray(resetData?.extra_storage_keys)
      ? resetData.extra_storage_keys
      : [];

    let filesRemoved = 0;
    const removeErrors: string[] = [];
    for (let i = 0; i < extraKeys.length; i += REMOVE_CHUNK) {
      const chunk = extraKeys.slice(i, i + REMOVE_CHUNK);
      const { data: removed, error: rmErr } = await admin.storage.from(BUCKET).remove(chunk);
      if (rmErr) {
        removeErrors.push(rmErr.message);
      } else {
        filesRemoved += removed?.length ?? 0;
      }
    }

    return jsonResponse(200, {
      success: removeErrors.length === 0,
      baseline_id: resetData?.baseline_id,
      baseline_captured_at: resetData?.baseline_captured_at,
      claims_before: resetData?.claims_before,
      documents_before: resetData?.documents_before,
      claims_restored: resetData?.claims_restored,
      documents_restored: resetData?.documents_restored,
      files_removed: filesRemoved,
      files_targeted: extraKeys.length,
      ...(removeErrors.length ? { storage_errors: removeErrors } : {}),
    });
  } catch (err: any) {
    console.error("admin-reset-environment error:", err);
    return jsonResponse(500, { error: err?.message || "internal_error" });
  }
});
