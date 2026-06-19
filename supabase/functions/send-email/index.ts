// Supabase Auth Send Email Hook → Resend
//
// Replaces Supabase's default email sender for every transactional auth email
// (signup confirmation, password reset, email-change, magic link, invite,
// reauthentication). Supabase POSTs to this endpoint with a Standard Webhooks
// signature; we verify, render a Spej-branded HTML/text email, and dispatch
// via the Resend API.
//
// Configuration (per Supabase project, via Management API):
//   hook_send_email_enabled = true
//   hook_send_email_uri = https://<ref>.supabase.co/functions/v1/send-email
//   hook_send_email_secrets = v1,whsec_<base64-secret>
//
// Required edge-function secrets:
//   RESEND_API_KEY      — Resend API key
//   SEND_EMAIL_HOOK_SECRET — base64 secret (matches the v1,whsec_ value above)
//
// Domain note: spej.dev must be verified in Resend (SPF + DKIM) for the
// info@spej.dev sender to deliver. Until verified, Resend returns 403 with
// "domain not verified" — the hook returns the error to Supabase and the
// signup/reset is blocked. Configure DNS at the GoDaddy panel.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";

// Sender uses the info.spej.dev subdomain (verified in Resend). Apex spej.dev
// is NOT verified — using it returns 403 "domain not verified" from Resend.
const FROM_ADDRESS = "Project C200 Demo Portal <noreply@info.spej.dev>";
const LOGO_URL = "https://ncp.spej.dev/logo.png";
const COMPANY_NAME = "Spej";
const PRODUCT_NAME = "Project C200 Demo Portal";
// Pulled from src/index.css design tokens — keep email branding in sync if
// those primary/secondary HSL values change.
const COLOR_NAVY = "#000b21";
const COLOR_RED = "#bb0021";
const COLOR_TEXT = "#1f2937";
const COLOR_MUTED = "#6b7280";
const COLOR_BG = "#f5f7fb";
// Header band is lighter than the page bg so the logo (which has dark text on
// a transparent background) reads clearly. Was COLOR_NAVY originally, but the
// Spej logo's black text disappeared against navy.
const COLOR_HEADER_BG = "#eef2f8";

type EmailActionType =
  | "signup"
  | "recovery"
  | "invite"
  | "magiclink"
  | "email_change"
  | "email_change_current"
  | "email_change_new"
  | "reauthentication";

interface SendEmailHookPayload {
  user: {
    id: string;
    email: string;
    user_metadata?: Record<string, unknown>;
  };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to?: string;
    email_action_type: EmailActionType;
    site_url?: string;
    token_new?: string;
    token_hash_new?: string;
  };
}

// =====================================================================
// Standard Webhooks signature verification
// =====================================================================

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function verifySignature(
  body: string,
  webhookId: string,
  webhookTimestamp: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  // Supabase stores the secret as "v1,whsec_<base64>". Strip the prefix.
  const stripped = secret.replace(/^v1,/, "").replace(/^whsec_/, "");
  const secretBytes = base64Decode(stripped);

  const signedPayload = `${webhookId}.${webhookTimestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = arrayBufferToBase64(sig);

  // signatureHeader may be "v1,<base64> v1,<base64>" — multiple sigs allowed.
  return signatureHeader.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    // Constant-time-ish compare — emails aren't a high-throughput target.
    if (value.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < value.length; i++) diff |= value.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

// =====================================================================
// Email template rendering
// =====================================================================

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const COPY: Record<EmailActionType, { subject: string; heading: string; intro: string; cta: string; outro: string }> = {
  signup: {
    subject: "Confirm your email",
    heading: "Confirm your email",
    intro:
      "Welcome to the Project C200 Demo Portal. To finish setting up your account, please confirm this email address.",
    cta: "Confirm email",
    outro:
      "If you didn't create an account, you can safely ignore this message.",
  },
  recovery: {
    subject: "Reset your password",
    heading: "Reset your password",
    intro:
      "We received a request to reset the password on your Project C200 Demo Portal account. Click the button below to choose a new password.",
    cta: "Reset password",
    outro:
      "If you didn't request a password reset, you can safely ignore this message — your password will stay the same.",
  },
  invite: {
    subject: `You've been invited to ${PRODUCT_NAME}`,
    heading: "You've been invited",
    intro:
      "An administrator has invited you to the Project C200 Demo Portal. Click the button below to accept and create your password.",
    cta: "Accept invitation",
    outro: "If you weren't expecting this invitation, you can safely ignore it.",
  },
  magiclink: {
    subject: "Sign in to the Spej Review Portal",
    heading: "Sign in",
    intro:
      "Click the button below to sign in to the Project C200 Demo Portal.",
    cta: "Sign in",
    outro:
      "If you didn't request a sign-in link, you can safely ignore this message.",
  },
  email_change: {
    subject: "Confirm your new email address",
    heading: "Confirm email change",
    intro: "Please confirm the change of email address on your account.",
    cta: "Confirm email change",
    outro: "If you didn't request this change, contact your administrator.",
  },
  email_change_current: {
    subject: "Confirm your email change",
    heading: "Confirm email change",
    intro:
      "We received a request to change the email on your account. To confirm, click the button below.",
    cta: "Confirm email change",
    outro: "If you didn't request this change, contact your administrator.",
  },
  email_change_new: {
    subject: "Confirm your new email address",
    heading: "Confirm new email",
    intro:
      "Please confirm that this is your new email address for the Project C200 Demo Portal.",
    cta: "Confirm new email",
    outro: "If you didn't request this change, contact your administrator.",
  },
  reauthentication: {
    subject: "Confirm your identity",
    heading: "Confirm your identity",
    intro:
      "To complete a sensitive action on your account, please confirm your identity with the code below.",
    cta: "",
    outro:
      "If you didn't trigger this, contact your administrator immediately.",
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildVerifyUrl(supabaseUrl: string, payload: SendEmailHookPayload): string {
  const { token_hash, email_action_type, redirect_to } = payload.email_data;
  const params = new URLSearchParams({
    token: token_hash,
    type: email_action_type,
  });
  if (redirect_to) params.set("redirect_to", redirect_to);
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1/verify?${params.toString()}`;
}

function renderEmail(payload: SendEmailHookPayload, supabaseUrl: string): RenderedEmail {
  const action = payload.email_data.email_action_type;
  const copy = COPY[action] ?? COPY.magiclink;
  const verifyUrl = buildVerifyUrl(supabaseUrl, payload);
  const token = payload.email_data.token;

  // Reauthentication uses an OTP code rather than a link. Other types use both
  // but lead with the button.
  const isOtpOnly = action === "reauthentication";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${COLOR_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${COLOR_TEXT};">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:${COLOR_BG};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
          <tr>
            <td style="background-color:${COLOR_HEADER_BG};padding:28px 32px;text-align:center;border-bottom:1px solid #d8dee9;">
              <img src="${LOGO_URL}" alt="${escapeHtml(COMPANY_NAME)}" width="64" style="display:inline-block;height:64px;width:auto;">
              <div style="margin-top:12px;color:${COLOR_NAVY};font-size:14px;letter-spacing:0.04em;text-transform:uppercase;font-weight:600;">${escapeHtml(PRODUCT_NAME)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 16px 0;font-size:24px;line-height:1.2;color:${COLOR_NAVY};font-weight:700;">${escapeHtml(copy.heading)}</h1>
              <p style="margin:0 0 24px 0;font-size:16px;line-height:1.6;color:${COLOR_TEXT};">${escapeHtml(copy.intro)}</p>
              ${
                isOtpOnly
                  ? `
              <div style="margin:24px 0;padding:20px;background-color:${COLOR_BG};border-radius:12px;text-align:center;">
                <div style="font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:${COLOR_MUTED};margin-bottom:8px;">Verification code</div>
                <div style="font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:32px;font-weight:700;color:${COLOR_NAVY};letter-spacing:0.2em;">${escapeHtml(token)}</div>
              </div>`
                  : `
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
                <tr>
                  <td style="border-radius:8px;background-color:${COLOR_RED};">
                    <a href="${verifyUrl}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(copy.cta)}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 8px 0;font-size:14px;color:${COLOR_MUTED};">Or paste this link into your browser:</p>
              <p style="margin:0 0 24px 0;font-size:13px;word-break:break-all;"><a href="${verifyUrl}" style="color:${COLOR_NAVY};">${verifyUrl}</a></p>
              <p style="margin:0 0 8px 0;font-size:14px;color:${COLOR_MUTED};">Or enter this code manually if prompted:</p>
              <p style="margin:0 0 24px 0;font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:16px;color:${COLOR_NAVY};">${escapeHtml(token)}</p>`
              }
              <p style="margin:24px 0 0 0;padding-top:24px;border-top:1px solid #e5e7eb;font-size:14px;color:${COLOR_MUTED};line-height:1.5;">${escapeHtml(copy.outro)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;background-color:${COLOR_BG};text-align:center;font-size:12px;color:${COLOR_MUTED};line-height:1.5;">
              <strong style="color:${COLOR_NAVY};">${escapeHtml(COMPANY_NAME)}</strong><br>
              For authorized personnel only. This is an automated message — please do not reply.<br>
              Contact your administrator if you need assistance.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // Plain-text fallback. Email clients that don't render HTML get this.
  const text = isOtpOnly
    ? `${copy.heading}\n\n${copy.intro}\n\nVerification code: ${token}\n\n${copy.outro}\n\n— ${COMPANY_NAME}`
    : `${copy.heading}\n\n${copy.intro}\n\n${copy.cta}: ${verifyUrl}\n\nOr enter this code manually if prompted: ${token}\n\n${copy.outro}\n\n— ${COMPANY_NAME}`;

  return { subject: copy.subject, html, text };
}

// =====================================================================
// Handler
// =====================================================================

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const HOOK_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
    if (!HOOK_SECRET) throw new Error("SEND_EMAIL_HOOK_SECRET is not configured");
    if (!SUPABASE_URL) throw new Error("SUPABASE_URL is not configured");

    const webhookId = req.headers.get("webhook-id");
    const webhookTimestamp = req.headers.get("webhook-timestamp");
    const webhookSignature = req.headers.get("webhook-signature");
    if (!webhookId || !webhookTimestamp || !webhookSignature) {
      return new Response(JSON.stringify({ error: "missing_webhook_headers" }), { status: 400 });
    }

    const rawBody = await req.text();
    const ok = await verifySignature(rawBody, webhookId, webhookTimestamp, webhookSignature, HOOK_SECRET);
    if (!ok) {
      console.error("Webhook signature verification failed");
      return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
    }

    // Scanner short-circuit (after HMAC verification, so signature surface
    // is still exercised). Prevents Resend from sending real mail.
    const scannerEarly = scannerShortCircuit(req);
    if (scannerEarly) return scannerEarly;

    const payload = JSON.parse(rawBody) as SendEmailHookPayload;
    if (!payload?.user?.email || !payload?.email_data?.email_action_type) {
      return new Response(JSON.stringify({ error: "invalid_payload" }), { status: 400 });
    }

    const { subject, html, text } = renderEmail(payload, SUPABASE_URL);

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: payload.user.email,
        subject,
        html,
        text,
      }),
    });

    if (!resendResponse.ok) {
      const errorText = await resendResponse.text();
      console.error(`Resend ${resendResponse.status}: ${errorText.substring(0, 500)}`);
      // Returning a 500 makes Supabase Auth surface the error to the caller —
      // signup/reset will fail loudly rather than silently swallow.
      return new Response(
        JSON.stringify({ error: `resend_${resendResponse.status}`, details: errorText.substring(0, 200) }),
        { status: 500 },
      );
    }

    const result = await resendResponse.json();
    console.log(`✅ Sent ${payload.email_data.email_action_type} email to ${payload.user.email} (resend id=${result.id})`);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("send-email hook error:", err);
    return new Response(
      JSON.stringify({ error: err?.message || "internal_error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
