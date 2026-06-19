// Kicks off the analysis pipeline for a manually-uploaded claim.
//
// The browser (New Analysis screen) uploads the PDFs to storage and inserts
// the `claims` + `claim_documents` rows directly under RLS, then calls this
// function with { claimId }. We dispatch analyze-claim-document for each of
// the claim's `pending` documents using the service role. Each analyze call
// returns immediately (async:true) and runs server-side, so the browser can
// close right after this returns — processing continues without it. The
// last document to finish fires synthesize-claim-extraction (analyze's own
// last-sibling logic), and the source-agnostic stuck-pending watchdog
// re-dispatches anything that never got picked up.
//
// verify_jwt stays at the platform default (true): this is a user-facing
// endpoint called from the browser with the user's JWT, NOT an internal
// service-role call. We additionally confirm the session in-function.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { dispatchForAnalysis, isStagedEnabled } from "../_shared/dispatch-analysis.ts";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "X-Content-Type-Options": "nosniff",
};

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

  let body: { claimId?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const claimId = (body.claimId ?? "").toString().trim();
  if (!claimId) return jsonResponse(400, { error: "missing_claimId" });

  // Confirm the caller is a signed-in user (verify_jwt also enforces this).
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return jsonResponse(401, { error: "unauthorized" });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: claim, error: claimErr } = await admin
    .from("claims")
    .select("id")
    .eq("id", claimId)
    .maybeSingle();
  if (claimErr) return jsonResponse(500, { error: "claim_lookup_failed", details: claimErr.message });
  if (!claim) return jsonResponse(404, { error: "claim_not_found" });

  // Smallest-first: we only kick off the first few documents right away and let
  // the concurrency-capped redispatch watchdog drain the rest. Firing every doc
  // of a large claim at once (e.g. a 14-part, >1 GB demand packet) OOM-kills the
  // analyze workers, which strands the docs in 'processing' with no error and no
  // progress. Smallest-first also makes the queue's progress bar move quickly.
  const { data: docs, error: docsErr } = await admin
    .from("claim_documents")
    .select("id, file_size")
    .eq("claim_id", claimId)
    .eq("processing_status", "pending")
    .order("file_size", { ascending: true, nullsFirst: true });
  if (docsErr) return jsonResponse(500, { error: "docs_lookup_failed", details: docsErr.message });

  // Mark the claim queued so the Review Queue shows it as in-progress. Only
  // advance from not_run/pending — never clobber a synthesis already running
  // or completed.
  await admin
    .from("claims")
    .update({ synthesis_status: "pending" })
    .eq("id", claimId)
    .in("synthesis_status", ["not_run", "pending"]);

  // Kick off only the first few documents (smallest first). The rest stay
  // 'pending'; the concurrency-capped imageright_redispatch_stuck_pending
  // watchdog tops the in-flight count back up every few minutes until the
  // backlog drains. This is what prevents a big claim from OOM-killing the
  // analyze workers by starting all of its documents at once.
  // Matches the manual concurrency cap in imageright_redispatch_stuck_pending
  // (6). Workers only ever see <=25 MB pre-split chunks now, so starting 6 at
  // once is safe (the old 200-280 MB whole-file OOM risk is gone). Each doc also
  // chains its next sibling on completion, so the claim then drains continuously.
  // STAGED on: enqueue ALL pending up front — the pump's batch cap paces the
  // in-flight work (queued != in-flight), so there's no OOM risk. STAGED off
  // (monolith): fire only the first few (smallest first) and let the
  // concurrency-capped imageright_redispatch_stuck_pending watchdog top the
  // in-flight count back up; each doc also chains its next sibling on completion.
  const MAX_INITIAL_DISPATCH = 6;
  const allPending = docs ?? [];
  const staged = await isStagedEnabled(admin);
  const toDispatch = staged ? allPending : allPending.slice(0, MAX_INITIAL_DISPATCH);
  let dispatched = 0;
  for (const d of toDispatch) {
    await dispatchForAnalysis(admin, d.id); // never throws; failures left 'pending' for the watchdog
    dispatched += 1;
  }

  return jsonResponse(200, {
    claimId,
    pending_docs: allPending.length,
    dispatched,
    deferred: allPending.length - dispatched,
  });
});
