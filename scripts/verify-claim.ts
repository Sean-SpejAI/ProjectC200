// scripts/verify-claim.ts
//
// Per-claim debug — pulls a claim + every doc + every analysis + the synthesis
// and renders a per-field provenance table. Flags inconsistencies like
// "synthesis confidence is high but the source doc was failed-grounding."
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     deno run --allow-env --allow-net scripts/verify-claim.ts <claim_id>
//
// On the user's machine the env vars typically come from the linked Supabase
// project's `.env` or from the Supabase Management API. Replace SERVICE_ROLE_KEY
// with the legacy JWT (eyJ… ~219 chars), not the sb_secret_* short form.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const claimId = Deno.args[0];
if (!claimId) {
  console.error("Usage: deno run --allow-env --allow-net scripts/verify-claim.ts <claim_id>");
  Deno.exit(2);
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars required");
  Deno.exit(2);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface DocRow {
  id: string;
  file_name: string | null;
  document_type: string | null;
  document_classifications: unknown;
  processing_status: string;
  grounding_status: string | null;
  grounding_score: number | null;
  extraction_completeness: number | null;
  analyzed_at: string | null;
  ai_summary: string | null;
  ai_analysis: Record<string, unknown> | null;
}

interface ClaimRow {
  id: string;
  claim_number: string | null;
  claimant_name: string | null;
  policy_number: string | null;
  incident_date: string | null;
  synthesis_status: string | null;
  synthesized_at: string | null;
  ai_synthesis: Record<string, unknown> | null;
}

const { data: claim, error: claimErr } = await supabase
  .from("claims")
  .select("id, claim_number, claimant_name, policy_number, incident_date, synthesis_status, synthesized_at, ai_synthesis")
  .eq("id", claimId)
  .maybeSingle<ClaimRow>();
if (claimErr) {
  console.error("Failed to fetch claim:", claimErr.message);
  Deno.exit(1);
}
if (!claim) {
  console.error("No claim with id", claimId);
  Deno.exit(1);
}

const { data: docs, error: docsErr } = await supabase
  .from("claim_documents")
  .select("id, file_name, document_type, document_classifications, processing_status, grounding_status, grounding_score, extraction_completeness, analyzed_at, ai_summary, ai_analysis")
  .eq("claim_id", claimId)
  .order("analyzed_at", { ascending: true, nullsFirst: true })
  .returns<DocRow[]>();
if (docsErr) {
  console.error("Failed to fetch docs:", docsErr.message);
  Deno.exit(1);
}

// ---- Render ----
console.log("=".repeat(80));
console.log(`CLAIM ${claim.claim_number ?? "(no number)"} — ${claim.id}`);
console.log("=".repeat(80));
console.log(`claimant_name      : ${claim.claimant_name ?? "(empty)"}`);
console.log(`policy_number      : ${claim.policy_number ?? "(empty)"}`);
console.log(`incident_date      : ${claim.incident_date ?? "(empty)"}`);
console.log(`synthesis_status   : ${claim.synthesis_status ?? "(empty)"}`);
console.log(`synthesized_at     : ${claim.synthesized_at ?? "(empty)"}`);

console.log("\nDocuments:");
console.log("-".repeat(80));
for (const d of docs ?? []) {
  const grade =
    d.grounding_status === "passed" ? "✅" :
    d.grounding_status === "partial" ? "⚠️" :
    d.grounding_status === "failed"  ? "❌" :
    "—";
  const score = d.grounding_score !== null ? `${(d.grounding_score * 100).toFixed(0)}%` : "n/a";
  const compl = d.extraction_completeness !== null ? `${(d.extraction_completeness * 100).toFixed(0)}%` : "n/a";
  const classes = Array.isArray(d.document_classifications)
    ? (d.document_classifications as Array<{ type: string; pageStart: number; pageEnd: number }>)
        .map((c) => `${c.type}(${c.pageStart}-${c.pageEnd})`).join(",")
    : "—";
  console.log(`${grade}  ${d.file_name ?? d.id}`);
  console.log(`     type=${d.document_type ?? "?"}  grounding=${d.grounding_status ?? "?"} ${score}  completeness=${compl}`);
  console.log(`     classifications=${classes}`);
  console.log(`     processing_status=${d.processing_status}  analyzed=${d.analyzed_at ?? "—"}`);
}

console.log("\nSynthesis output (top-level):");
console.log("-".repeat(80));
const syn = claim.ai_synthesis as Record<string, unknown> | null;
if (!syn) {
  console.log("  (no synthesis yet)");
} else {
  for (const k of ["claim_number","claimant_name","policy_number","incident_date","incident_description","accident_location","demand_total","confidence"]) {
    const v = (syn as Record<string, unknown>)[k];
    console.log(`  ${k.padEnd(22)} ${v === null || v === undefined ? "(null)" : JSON.stringify(v)}`);
  }
}

console.log("\nProvenance (PR-B output — empty for pre-PR-B claims):");
console.log("-".repeat(80));
const prov = syn?._provenance as Record<string, { value?: unknown; confidence?: number; sources?: Array<Record<string, unknown>> }> | undefined;
if (!prov) {
  console.log("  (no _provenance block — re-synthesize after PR-B to populate)");
} else {
  for (const [field, p] of Object.entries(prov)) {
    console.log(`  ${field}:`);
    console.log(`    value=${JSON.stringify(p.value)}  confidence=${p.confidence?.toFixed(2) ?? "?"}`);
    for (const s of p.sources ?? []) {
      const docFile = (s.file_name as string) ?? s.doc_id;
      const gs = s.grounding_status as string;
      const gscore = s.grounding_score as number | null;
      const flag = gs === "failed" && (p.confidence ?? 0) >= 0.7
        ? "  ⚠️ HIGH-CONFIDENCE FROM FAILED-GROUNDING DOC"
        : "";
      console.log(`      ← ${docFile} (grounding=${gs}, score=${gscore !== null ? (gscore * 100).toFixed(0) + "%" : "n/a"}, page=${s.page_ref ?? "—"})${flag}`);
    }
  }
}

console.log("\nConflicts:");
console.log("-".repeat(80));
const conflicts = (syn?.conflicts as Array<Record<string, unknown>>) ?? [];
if (conflicts.length === 0) {
  console.log("  (none)");
} else {
  for (const c of conflicts) {
    console.log(`  field=${c.field}  chose=${JSON.stringify(c.chosen)}  reason=${c.reason}`);
    console.log(`    candidates=${JSON.stringify(c.values)}`);
  }
}
