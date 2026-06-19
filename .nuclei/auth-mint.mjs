#!/usr/bin/env node
//
// Pre-scan auth helper for Nuclei. Sign in the scanner user, complete TOTP,
// and emit a plain `token.txt` containing the resulting AAL2 access token.
// The workflow reads this file into Nuclei's `-H "Authorization: Bearer …"`
// argument so the scanner exercises the auth'd surface.
//
// Driven by env vars (set by the GitHub Actions workflow):
//   SUPABASE_URL              e.g. https://evpmuoxfrnmustokkaqg.supabase.co
//   SUPABASE_ANON_KEY         project anon key (legacy JWT or sb_publishable_*)
//   ZAP_USER_EMAIL            zap-scanner+<env>@spej.ai (same user as ZAP)
//   ZAP_USER_PASSWORD         password for that user
//   ZAP_TOTP_SECRET           base32 TOTP shared secret captured at enrollment
//
// Writes `${OUT_FILE:-token.txt}` containing just the JWT, no trailing newline.
//
// Why share the ZAP_* secret names: this scanner uses the same scanner user
// (zap-scanner+<env>@spej.ai) and side-effect guard pattern that ZAP does —
// no point provisioning a parallel identity. The SCANNER_TOKEN side-effect
// header is injected in the workflow yaml, not here, because it's a constant
// per-env.

import { createClient } from "@supabase/supabase-js";
import * as OTPAuth from "otpauth";
import { writeFileSync } from "node:fs";

const REQUIRED = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "ZAP_USER_EMAIL",
  "ZAP_USER_PASSWORD",
  "ZAP_TOTP_SECRET",
];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`auth-mint: missing required env vars: ${missing.join(", ")}`);
  process.exit(2);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: process.env.ZAP_USER_EMAIL,
    password: process.env.ZAP_USER_PASSWORD,
  });
  if (signInErr) throw new Error(`signInWithPassword failed: ${signInErr.message}`);

  const { data: factorsData, error: factorsErr } = await supabase.auth.mfa.listFactors();
  if (factorsErr) throw new Error(`mfa.listFactors failed: ${factorsErr.message}`);
  const totp = factorsData?.totp?.find((f) => f.status === "verified");
  if (!totp) throw new Error("no verified TOTP factor on scanner user — re-enroll");

  const totpDriver = new OTPAuth.TOTP({
    issuer: "Nodak",
    label: process.env.ZAP_USER_EMAIL,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(process.env.ZAP_TOTP_SECRET.replace(/\s+/g, "")),
  });
  const code = totpDriver.generate();

  const { error: verifyErr } = await supabase.auth.mfa.challengeAndVerify({
    factorId: totp.id,
    code,
  });
  if (verifyErr) throw new Error(`mfa.challengeAndVerify failed: ${verifyErr.message}`);

  const { data: sessData, error: sessErr } = await supabase.auth.getSession();
  if (sessErr || !sessData.session) {
    throw new Error(`getSession after AAL2 failed: ${sessErr?.message ?? "no session"}`);
  }
  const accessToken = sessData.session.access_token;

  const outFile = process.env.OUT_FILE || "token.txt";
  writeFileSync(outFile, accessToken, "utf8");
  console.log(`auth-mint: wrote ${outFile} (AAL2 JWT, ${accessToken.length} chars)`);
}

main().catch((err) => {
  console.error(`auth-mint: ${err.message}`);
  process.exit(1);
});
