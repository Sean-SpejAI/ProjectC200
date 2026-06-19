import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "X-Content-Type-Options": "nosniff",
};

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalize(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const body = await req.json();
    const rawCode: string | undefined = body?.code;
    if (!rawCode || typeof rawCode !== "string") {
      return new Response(JSON.stringify({ error: "missing_code" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Verify caller's JWT (any AAL is fine — backup code IS the second factor).
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    const userId = userData.user.id;

    const codeHash = await sha256Hex(normalize(rawCode));

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Atomic "redeem one unused code" — UPDATE...RETURNING via PostgREST.
    const { data: redeemed, error: redeemErr } = await admin
      .from("mfa_backup_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("code_hash", codeHash)
      .is("used_at", null)
      .select("id")
      .maybeSingle();

    if (redeemErr) throw redeemErr;
    if (!redeemed) {
      return new Response(JSON.stringify({ error: "invalid_code" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Clear all MFA factors for this user — they're locked out of their
    // authenticator, so the only way back in is to re-enroll on a new device.
    // auth.mfa_factors isn't exposed via PostgREST; the SECURITY DEFINER
    // helper from the migration handles the cross-schema delete.
    const { error: rpcErr } = await admin.rpc("admin_clear_mfa_factors", {
      target_user_id: userId,
    });
    if (rpcErr) throw rpcErr;

    // Purge any spent codes — the user will get a fresh set when they re-enroll.
    await admin.from("mfa_backup_codes").delete().eq("user_id", userId);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err: any) {
    console.error("verify-backup-code error:", err);
    return new Response(
      JSON.stringify({ error: err?.message || "internal_error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }
});
