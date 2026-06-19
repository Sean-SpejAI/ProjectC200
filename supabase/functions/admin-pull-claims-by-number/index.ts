// Service-role-callable bulk claim pull by claim_number.
//
// reload-claim-from-imageright already does this for a SINGLE claim — but it
// requires an admin user JWT. This function does the same work using
// service-role bearer auth so an operator can pull a batch of claim numbers
// from a script / curl without going through the UI.
//
// Mirrors the proxy + SOAP path used by reload-claim-from-imageright:
//   1. resolveFileIdByClaimNumber(n) — SOAP FindFilesEx via the proxy
//   2. pullClaim(fileId, {runId, isReload:false}) — upserts claim row +
//      enumerates docs + dispatches analyze for each
//
// Admin-only. verify_jwt=false at the platform layer (see config.toml);
// authorization is enforced in-function by requiring the Authorization
// header to carry the service-role key.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { pullClaim, resolveFileIdByClaimNumber, type FolderFilter } from "../_shared/imageright-pull-claim.ts";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "X-Content-Type-Options": "nosniff",
};

// A claim to pull, optionally scoped to specific folders / document types.
interface PullClaimSpec {
  claim_number: string;
  folderFilter?: FolderFilter;
}

interface PullRequest {
  // Plain list — pulls every folder/doc (legacy, incremental refresh).
  claim_numbers?: string[];
  // Richer shape — per-claim folder/type scoping (curated targeted pull).
  claims?: PullClaimSpec[];
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorize(req: Request, serviceKey: string): boolean {
  const header = req.headers.get("Authorization") ?? "";
  const presented = header.replace(/^Bearer\s+/i, "");
  if (!presented) return false;
  return timingSafeEqual(presented, serviceKey);
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const IMAGERIGHT_PROXY_URL = Deno.env.get("IMAGERIGHT_PROXY_URL");
  const IMAGERIGHT_PROXY_TOKEN = Deno.env.get("IMAGERIGHT_PROXY_TOKEN");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "supabase_not_configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
  if (!IMAGERIGHT_PROXY_URL || !IMAGERIGHT_PROXY_TOKEN) {
    return new Response(JSON.stringify({ error: "imageright_proxy_not_configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  if (!authorize(req, SUPABASE_SERVICE_ROLE_KEY)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Scanner guard AFTER auth so scanner exercises auth path.
  const scannerEarly = scannerShortCircuit(req, corsHeaders);
  if (scannerEarly) return scannerEarly;

  let body: PullRequest = {};
  try {
    body = (await req.json()) as PullRequest;
  } catch {
    body = {};
  }

  // Build the unified target list from both payload shapes. `claims[]` entries
  // carry per-claim folder filters; `claim_numbers[]` are unfiltered.
  const targets: PullClaimSpec[] = [];
  for (const c of body.claims ?? []) {
    const n = (c?.claim_number ?? "").toString().trim();
    if (n.length > 0) targets.push({ claim_number: n, folderFilter: c?.folderFilter });
  }
  for (const n of body.claim_numbers ?? []) {
    const s = (n ?? "").toString().trim();
    if (s.length > 0) targets.push({ claim_number: s });
  }

  if (targets.length === 0) {
    return new Response(JSON.stringify({ error: "claim_numbers_required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Create a manual sync_run so this batch is auditable.
  const { data: run, error: runErr } = await admin
    .from("imageright_sync_runs")
    .insert({
      run_type: "manual_reload",
      status: "running",
      notes: `bulk pull x${targets.length}: ${targets.map((t) => t.claim_number).join(",")}`,
    })
    .select("id")
    .single();

  if (runErr || !run) {
    return new Response(
      JSON.stringify({ error: "run_insert_failed", details: runErr?.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }

  const results: Array<{
    claim_number: string;
    outcome: string;
    file_id?: number;
    claim_id?: string | null;
    docs_created?: number;
    docs_pending_content?: number;
    docs_with_content?: number;
    docs_filtered_out?: number;
    error?: string;
  }> = [];

  for (const target of targets) {
    const claimNumber = target.claim_number;
    try {
      const resolved = await resolveFileIdByClaimNumber(claimNumber);
      if (resolved == null) {
        results.push({ claim_number: claimNumber, outcome: "not_found_in_imageright" });
        continue;
      }

      const pullResult = await pullClaim(resolved, {
        runId: run.id,
        // A curated (folder-filtered) pull replaces any prior full pull, so
        // wipe + re-pull. Unfiltered list calls keep the legacy incremental
        // refresh (skip-unchanged) behavior.
        isReload: target.folderFilter != null,
        folderFilter: target.folderFilter,
      });

      results.push({
        claim_number: claimNumber,
        outcome: pullResult.status,
        file_id: resolved,
        claim_id: pullResult.claim_id,
        docs_created: pullResult.docs_created,
        docs_pending_content: pullResult.docs_pending_content,
        docs_with_content: pullResult.docs_with_content,
        docs_filtered_out: pullResult.docs_filtered_out,
        error: pullResult.errors[0]?.message,
      });
    } catch (err) {
      results.push({
        claim_number: claimNumber,
        outcome: "exception",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const succeeded = results.filter((r) =>
    r.outcome === "succeeded" || r.outcome === "content_pending"
  ).length;
  const notFound = results.filter((r) => r.outcome === "not_found_in_imageright").length;
  const failed = results.length - succeeded - notFound;

  await admin
    .from("imageright_sync_runs")
    .update({
      status: failed > 0 ? "partial" : "completed",
      completed_at: new Date().toISOString(),
      claims_found: targets.length - notFound,
      claims_synced: succeeded,
      documents_created: results.reduce((s, r) => s + (r.docs_created ?? 0), 0),
      documents_pending_content: results.reduce((s, r) => s + (r.docs_pending_content ?? 0), 0),
    })
    .eq("id", run.id);

  return new Response(
    JSON.stringify({
      run_id: run.id,
      requested: targets.length,
      succeeded,
      not_found_in_imageright: notFound,
      failed,
      results,
    }),
    { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
  );
};

serve(handler);
