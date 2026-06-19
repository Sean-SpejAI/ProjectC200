// Mints a short-lived signed URL for a claim document's PDF, for logged-in users.
//
// The `claim-documents` bucket is PRIVATE — no client can read storage directly.
// The browser calls this function with a `documentId` (NOT a raw storage path,
// so a caller can't request arbitrary objects); we verify the user's session,
// look up that document's storage path with the service role, and return a
// signed URL valid for 1 hour. Any authenticated Nodak staff user may open any
// claim's document (matches the app's model where all staff see all claims).
//
// verify_jwt stays at the platform default (true): this is a user-facing
// endpoint called from the browser with the user's JWT. We also confirm the
// session in-function.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { storagePathFromFileUrl } from "../_shared/storage-path.ts";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "X-Content-Type-Options": "nosniff",
};

const SIGNED_URL_TTL_SECONDS = 3600;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

  const scannerEarly = scannerShortCircuit(req, corsHeaders);
  if (scannerEarly) return scannerEarly;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse(401, { error: "unauthorized" });

  let body: { documentId?: string; page?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const documentId = (body.documentId ?? "").toString().trim();
  if (!documentId) return jsonResponse(400, { error: "missing_documentId" });
  const page = Number.isFinite(Number(body.page)) && Number(body.page) > 0 ? Math.floor(Number(body.page)) : null;

  // Confirm the caller is a signed-in user (verify_jwt also enforces this).
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return jsonResponse(401, { error: "unauthorized" });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: doc, error: docErr } = await admin
    .from("claim_documents")
    .select("id, file_url")
    .eq("id", documentId)
    .maybeSingle();
  if (docErr) return jsonResponse(500, { error: "lookup_failed", details: docErr.message });
  if (!doc) return jsonResponse(404, { error: "document_not_found" });
  if (!doc.file_url) return jsonResponse(404, { error: "no_file", detail: "document has no stored file" });

  const path = storagePathFromFileUrl(doc.file_url as string);
  const { data: signed, error: signErr } = await admin.storage
    .from("claim-documents")
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (signErr || !signed?.signedUrl) {
    return jsonResponse(502, { error: "sign_failed", details: signErr?.message ?? "no_signed_url" });
  }

  const url = page ? `${signed.signedUrl}#page=${page}` : signed.signedUrl;
  return jsonResponse(200, { url, expiresIn: SIGNED_URL_TTL_SECONDS });
});
