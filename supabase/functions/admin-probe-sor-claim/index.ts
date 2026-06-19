// Service-role-callable diagnostic: is a claim's document data actually present
// in the Sor environment our integration is connected to?
//
// Answers in one call by combining BOTH the real pull path (recursive
// GetContent folder walk) AND an independent server-side document search
// (FindDocumentsEx — can't share a traversal bug), and reports which backend
// connection (connName) the appsvr exposes. Returns a machine-readable verdict:
//   file_not_found_in_environment | file_present_empty | file_present_sparse | documents_present
// with the raw counts + byType breakdown so it's fully auditable. This is the
// durable replacement for hand-built raw-SOAP probes when verifying whether a
// data load landed (or whether docs the desktop client shows live in a
// different Sor environment than the one we connect to).
//
// Mirrors admin-inspect-sor-file's auth: verify_jwt=false at the platform
// layer (see config.toml); authorization is enforced in-function by requiring
// the Authorization bearer to equal SUPABASE_SERVICE_ROLE_KEY (the sb_secret_*
// short-form key, NOT the legacy JWT in sor_settings).
//
// Body (JSON):
//   { "claim_number": "0000325507" }

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { clientFromEnv } from "../_shared/sor-client.ts";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "X-Content-Type-Options": "nosniff",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorize(req: Request, serviceKey: string): boolean {
  const presented = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return presented.length > 0 && timingSafeEqual(presented, serviceKey);
}

interface ProbeRequest {
  claim_number?: string;
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const PROXY_URL = Deno.env.get("SOR_PROXY_URL");
  const PROXY_TOKEN = Deno.env.get("SOR_PROXY_TOKEN");

  if (!SERVICE_ROLE_KEY) return jsonResponse(500, { error: "supabase_not_configured" });
  if (!PROXY_URL || !PROXY_TOKEN) return jsonResponse(500, { error: "sor_proxy_not_configured" });

  if (!authorize(req, SERVICE_ROLE_KEY)) return jsonResponse(401, { error: "unauthorized" });

  // Scanner guard AFTER auth so the scanner exercises the auth path.
  const scannerEarly = scannerShortCircuit(req, corsHeaders);
  if (scannerEarly) return scannerEarly;

  let body: ProbeRequest = {};
  try {
    body = (await req.json()) as ProbeRequest;
  } catch {
    body = {};
  }

  const claimNumber = (body.claim_number ?? "").toString().trim();
  if (!claimNumber) return jsonResponse(400, { error: "claim_number_required" });

  try {
    const ir = clientFromEnv();
    const { ok, probe, error } = await ir.probeClaim(claimNumber);
    if (!ok) {
      return jsonResponse(502, {
        error: "proxy_error",
        status: error?.status,
        message: error?.upstreamMessage,
      });
    }
    return jsonResponse(200, probe as Record<string, unknown>);
  } catch (err) {
    return jsonResponse(500, {
      error: "exception",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
