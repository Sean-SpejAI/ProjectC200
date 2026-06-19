// Service-role-callable diagnostic: inspect what ImageRight actually holds for
// a claim. Returns the FULL file inventory — every folder + document, including
// deleted/cut items, each with its delete state — so an operator can verify a
// claim's contents (e.g. confirm a data load landed) without manual raw-SOAP
// probing.
//
// Mirrors admin-pull-claims-by-number's auth: verify_jwt=false at the platform
// layer (see config.toml); authorization is enforced in-function by requiring
// the Authorization bearer to equal SUPABASE_SERVICE_ROLE_KEY.
//
// Body (JSON):
//   { "claim_number": "0000360689" }            — resolve to fileId via SOAP, then inventory
//   { "file_id": 104999104 }                    — inventory by ImageRight file id directly
//   optional: "include_deleted": false          — hide deleted/cut (defaults to true)

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { clientFromEnv } from "../_shared/imageright-client.ts";
import { resolveFileIdByClaimNumber } from "../_shared/imageright-pull-claim.ts";
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

interface InspectRequest {
  claim_number?: string;
  file_id?: number;
  include_deleted?: boolean;
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const PROXY_URL = Deno.env.get("IMAGERIGHT_PROXY_URL");
  const PROXY_TOKEN = Deno.env.get("IMAGERIGHT_PROXY_TOKEN");

  if (!SERVICE_ROLE_KEY) return jsonResponse(500, { error: "supabase_not_configured" });
  if (!PROXY_URL || !PROXY_TOKEN) return jsonResponse(500, { error: "imageright_proxy_not_configured" });

  if (!authorize(req, SERVICE_ROLE_KEY)) return jsonResponse(401, { error: "unauthorized" });

  // Scanner guard AFTER auth so the scanner exercises the auth path.
  const scannerEarly = scannerShortCircuit(req, corsHeaders);
  if (scannerEarly) return scannerEarly;

  let body: InspectRequest = {};
  try {
    body = (await req.json()) as InspectRequest;
  } catch {
    body = {};
  }

  const includeDeleted = body.include_deleted !== false; // default true
  const claimNumber = (body.claim_number ?? "").toString().trim();
  let fileId = Number(body.file_id);

  try {
    if (!Number.isFinite(fileId) || fileId <= 0) {
      if (!claimNumber) {
        return jsonResponse(400, { error: "claim_number_or_file_id_required" });
      }
      const resolved = await resolveFileIdByClaimNumber(claimNumber);
      if (resolved == null) {
        return jsonResponse(200, {
          found: false,
          claim_number: claimNumber,
          reason: "not_found_in_imageright",
        });
      }
      fileId = resolved;
    }

    const ir = clientFromEnv();
    const { ok, inventory, error } = await ir.getFileInventory(fileId, includeDeleted);
    if (!ok) {
      return jsonResponse(502, {
        error: "proxy_error",
        status: error?.status,
        message: error?.upstreamMessage,
      });
    }

    return jsonResponse(200, {
      found: true,
      claim_number: claimNumber || null,
      file_id: fileId,
      ...(inventory as Record<string, unknown>),
    });
  } catch (err) {
    return jsonResponse(500, {
      error: "exception",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
