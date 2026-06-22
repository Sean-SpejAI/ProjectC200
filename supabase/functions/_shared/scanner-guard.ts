// Shared short-circuit for ZAP (and other) automated security scans.
//
// Scanner workflows inject an `x-scanner-run` header on every request. When
// the value matches the `SCANNER_TOKEN` Edge Function env var, side-effecting
// functions return a synthetic 200 and skip the real work — so scans can
// exercise auth + input-validation surface without triggering Sor
// pulls, Resend emails, or Gemini API calls.
//
// The guard is INERT in environments where `SCANNER_TOKEN` isn't set, so
// accidentally setting the header on a production project that lacks the
// secret has no effect. Constant-time comparison prevents header-value
// guessing via response-timing.
//
// Callers MUST run scanner-guard AFTER their auth/signature checks so the
// scanner still exercises those code paths.

const corsHeadersDefault = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-scanner-run",
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isScannerRun(req: Request): boolean {
  const expected = Deno.env.get("SCANNER_TOKEN");
  if (!expected) return false;
  const presented = req.headers.get("x-scanner-run");
  if (!presented) return false;
  return timingSafeEqual(presented, expected);
}

export function scannerShortCircuit(
  req: Request,
  corsHeaders: Record<string, string> = corsHeadersDefault,
): Response | null {
  if (!isScannerRun(req)) return null;
  return new Response(
    JSON.stringify({ ok: true, scanner: true }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}
