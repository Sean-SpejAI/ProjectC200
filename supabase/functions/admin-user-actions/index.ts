// Admin-only user lifecycle actions: suspend, unsuspend, delete, create_user,
// set_password.
//
// Suspend uses Supabase Auth's ban_duration (effectively a soft ban — the user
// stays in auth.users but cannot sign in; their data is preserved).
// Delete is hard — auth.admin.deleteUser cascades to profiles, user_roles,
// mfa_backup_codes via ON DELETE CASCADE foreign keys.
// create_user uses auth.admin.inviteUserByEmail — the invite email goes out
// through the auth-hook → send-email Edge Function → Resend pipeline. After
// the user clicks the invite link they set their own password.
// set_password directly updates the user's password via
// auth.admin.updateUserById. The admin chose the value (typed or
// generated client-side) and is responsible for relaying it to the user
// out-of-band. Use when the email-reset round-trip isn't acceptable
// (e.g. user lost access to their email, urgent re-credential, etc.).
//
// The caller MUST be authenticated AND have the 'admin' role in user_roles;
// both checks happen below using the service-role client (bypassing RLS).

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "X-Content-Type-Options": "nosniff",
};

type Action = "suspend" | "unsuspend" | "delete" | "create_user" | "set_password";
type AppRole = "admin" | "claims_manager" | "claims_reviewer";

// "Permanent" ban — Supabase requires a duration, not a flag. 100 years is
// the maximum effective duration without overflowing the bigint they use.
const PERMANENT_BAN = "876600h";

// Mirrors Supabase Auth's default Password.MinLength setting.
const MIN_PASSWORD_LENGTH = 8;

const VALID_ACTIONS: Action[] = [
  "suspend",
  "unsuspend",
  "delete",
  "create_user",
  "set_password",
];
const VALID_ROLES: AppRole[] = ["admin", "claims_manager", "claims_reviewer"];

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
    const action = body?.action as Action | undefined;
    const targetUserId = body?.targetUserId as string | undefined;
    // create_user-specific fields
    const newEmail = (body?.email as string | undefined)?.trim().toLowerCase();
    const newFullName = (body?.fullName as string | undefined)?.trim();
    const newDepartment = (body?.department as string | undefined)?.trim();
    const newInitialRole = body?.initialRole as AppRole | undefined;
    // set_password-specific field
    const newPassword = body?.newPassword as string | undefined;

    if (!action || !VALID_ACTIONS.includes(action)) {
      return new Response(JSON.stringify({ error: "invalid_action" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Most actions need a targetUserId; create_user uses email instead.
    const isTargetUserIdRequired = ["suspend", "unsuspend", "delete", "set_password"].includes(
      action,
    );
    if (isTargetUserIdRequired && (!targetUserId || typeof targetUserId !== "string")) {
      return new Response(JSON.stringify({ error: "missing_targetUserId" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    if (action === "create_user") {
      if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        return new Response(JSON.stringify({ error: "invalid_or_missing_email" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      if (newInitialRole !== undefined && !VALID_ROLES.includes(newInitialRole)) {
        return new Response(JSON.stringify({ error: "invalid_initial_role" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }
    if (action === "set_password") {
      if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
        return new Response(
          JSON.stringify({
            error: "weak_or_missing_password",
            message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
          }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }
    }

    // Authenticate the caller via their JWT.
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

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Authorize via service-role role check (bypasses RLS).
    const { data: roleRow, error: roleErr } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (roleErr) throw roleErr;
    if (!roleRow) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Guardrail: don't let an admin lock themselves out by accident.
    // (create_user has no targetUserId; skip this check for it.)
    if (
      action !== "create_user" &&
      targetUserId &&
      targetUserId === userData.user.id
    ) {
      return new Response(
        JSON.stringify({ error: "cannot_act_on_self" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }

    if (action === "suspend") {
      const { error } = await admin.auth.admin.updateUserById(targetUserId!, {
        ban_duration: PERMANENT_BAN,
      });
      if (error) throw error;
    } else if (action === "unsuspend") {
      const { error } = await admin.auth.admin.updateUserById(targetUserId!, {
        ban_duration: "none",
      });
      if (error) throw error;
    } else if (action === "delete") {
      const { error } = await admin.auth.admin.deleteUser(targetUserId!);
      if (error) throw error;
    } else if (action === "create_user") {
      // Invite the user — Supabase Auth creates the auth.users row in an
      // "invited" state and emits an invite email (through our auth-hook →
      // send-email Edge Function → Resend pipeline). The link in the email
      // lets them set their own password, after which auth.users.email_confirmed_at
      // is populated. We don't generate or store a temporary password here —
      // never seeing the user's password is the point of the invite flow.
      const { data: inviteData, error: inviteErr } = await admin.auth.admin
        .inviteUserByEmail(newEmail!, {
          data: { full_name: newFullName ?? null },
        });
      if (inviteErr) {
        // Common case: email already registered
        const msg = inviteErr.message || "invite_failed";
        const status = /already (registered|been registered)/i.test(msg) ? 409 : 400;
        return new Response(
          JSON.stringify({ error: "invite_failed", message: msg }),
          { status, headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      const newUserId = inviteData?.user?.id;
      if (!newUserId) throw new Error("invite_user_id_missing");

      // Insert profile row. The profile row may already exist if a DB trigger
      // creates one on auth.users insert; upsert defensively. The columns here
      // mirror what the existing fetchUsers() select expects.
      const { error: profileErr } = await admin
        .from("profiles")
        .upsert(
          {
            user_id: newUserId,
            full_name: newFullName || null,
            department: newDepartment || null,
          },
          { onConflict: "user_id" },
        );
      if (profileErr) {
        // Don't fail the whole invite over a profile row — the user still got
        // the email and can sign in. Log it for visibility.
        console.error("create_user profile upsert error:", profileErr);
      }

      // Optionally seed an initial role so the user lands on a working
      // experience instead of "Pending approval".
      if (newInitialRole) {
        const { error: roleErr } = await admin
          .from("user_roles")
          .insert({ user_id: newUserId, role: newInitialRole });
        if (roleErr) console.error("create_user initial-role insert error:", roleErr);
      }

      return new Response(
        JSON.stringify({
          success: true,
          action,
          userId: newUserId,
          email: newEmail,
          invited: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    } else if (action === "set_password") {
      // Admin chose the value — either typed manually or generated client-side.
      // We never log or echo it. Just write through to auth.
      //
      // Bypass supabase-js v2.45's auth.admin.updateUserById (it 400'd in
      // testing on prod even though the underlying REST endpoint accepts the
      // same key + body fine via direct curl) and hit /auth/v1/admin/users/:id
      // ourselves. Same effect, fewer abstraction layers.
      const authResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${targetUserId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          apikey: SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: newPassword }),
      });

      if (!authResp.ok) {
        const text = await authResp.text();
        console.error("set_password REST error:", authResp.status, text);
        let message = text;
        try {
          const parsed = JSON.parse(text);
          message = parsed.msg || parsed.message || parsed.error_description || text;
        } catch { /* keep raw text */ }
        return new Response(
          JSON.stringify({
            error: "set_password_failed",
            message,
            auth_status: authResp.status,
          }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } },
        );
      }

      return new Response(
        JSON.stringify({ success: true, action, userId: targetUserId }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    return new Response(JSON.stringify({ success: true, action }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err: any) {
    console.error("admin-user-actions error:", err);
    return new Response(
      JSON.stringify({ error: err?.message || "internal_error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }
});
