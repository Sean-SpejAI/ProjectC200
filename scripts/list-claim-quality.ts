// scripts/list-claim-quality.ts
//
// Bulk per-claim quality snapshot. Run before + after a backfill to see
// whether the quality picture moved. Emits CSV to stdout.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     deno run --allow-env --allow-net scripts/list-claim-quality.ts > backfill_before.csv
//
// Columns:
//   claim_id, claim_number, doc_count, avg_grounding_score, passed_count,
//   partial_count, failed_count, not_run_count, synthesis_status,
//   synthesis_confidence

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars required");
  Deno.exit(2);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Pull all claims. For large prod sets, batch via .range() — at current
// scale (~250 claims) a single query is fine.
const { data: claims, error: claimsErr } = await supabase
  .from("claims")
  .select("id, claim_number, synthesis_status, ai_synthesis")
  .order("created_at", { ascending: false });
if (claimsErr) {
  console.error("Failed to fetch claims:", claimsErr.message);
  Deno.exit(1);
}

console.log("claim_id,claim_number,doc_count,avg_grounding_score,passed,partial,failed,not_run,synthesis_status,synthesis_confidence");

for (const c of claims ?? []) {
  const { data: docs } = await supabase
    .from("claim_documents")
    .select("grounding_status, grounding_score")
    .eq("claim_id", c.id);
  const docList = docs ?? [];
  const passed   = docList.filter(d => d.grounding_status === "passed").length;
  const partial  = docList.filter(d => d.grounding_status === "partial").length;
  const failed   = docList.filter(d => d.grounding_status === "failed").length;
  const notRun   = docList.filter(d => d.grounding_status === "not_run" || d.grounding_status === null).length;
  const scored   = docList.filter(d => typeof d.grounding_score === "number");
  const avgScore = scored.length > 0
    ? (scored.reduce((acc, d) => acc + (d.grounding_score as number), 0) / scored.length).toFixed(3)
    : "";
  const synConf  = (c.ai_synthesis as Record<string, unknown> | null)?.confidence ?? "";
  const cn = (c.claim_number ?? "").replaceAll(",", " ");
  console.log([
    c.id, cn, docList.length, avgScore, passed, partial, failed, notRun,
    c.synthesis_status ?? "", String(synConf),
  ].join(","));
}
