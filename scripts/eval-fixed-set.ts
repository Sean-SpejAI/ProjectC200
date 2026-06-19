// scripts/eval-fixed-set.ts
//
// Golden-set regression gate. Reads scripts/golden-set.json (hand-labeled
// ground-truth field values for ~20 stratified prod claims), pulls the
// current synthesis from each claim, and computes per-field precision /
// recall / F1. Exits non-zero if any required field's F1 drops below a
// threshold — wire into CI on PRs that touch the extraction pipeline.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     deno run --allow-env --allow-read --allow-net scripts/eval-fixed-set.ts
//
// Authoring the golden set:
//   1. Pick ~20 claims spanning correspondence-only, medical-records,
//      demand-letter, declarations-page, bills, and one multi-content bundle.
//   2. For each claim, manually look at the source PDFs and record the
//      ground-truth value for the canonical fields.
//   3. Add an entry to scripts/golden-set.json (see the type def below).
//
// The harness deliberately allows partial labels — if a field's expected
// value is null, it's treated as "no opinion" and excluded from scoring for
// that claim.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface GoldenLabel {
  claim_id: string;
  notes?: string;
  expected: {
    claim_number?: string | null;
    claimant_name?: string | null;
    policy_number?: string | null;
    incident_date?: string | null;        // ISO YYYY-MM-DD
    incident_description?: string | null; // substring match
    accident_location?: string | null;    // substring match
    demand_total?: number | null;         // ±5% tolerance
  };
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const THRESHOLD = Number(Deno.env.get("EVAL_F1_THRESHOLD") ?? "0.6");

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars required");
  Deno.exit(2);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const goldenPath = new URL("./golden-set.json", import.meta.url);
let golden: GoldenLabel[];
try {
  const txt = await Deno.readTextFile(goldenPath);
  golden = JSON.parse(txt);
} catch (err) {
  console.error(`Failed to read golden-set.json: ${err instanceof Error ? err.message : String(err)}`);
  console.error("Create scripts/golden-set.json with an array of GoldenLabel entries — see the script comment for the shape.");
  Deno.exit(2);
}

if (!Array.isArray(golden) || golden.length === 0) {
  console.error("golden-set.json must be a non-empty array of GoldenLabel entries.");
  Deno.exit(2);
}

// ---- Comparators ----
const eqString = (expected: string | null, actual: unknown): boolean => {
  if (expected === null) return true;
  if (typeof actual !== "string") return false;
  // Loose normalization — collapse whitespace, case-fold.
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(actual) === norm(expected);
};
const containsString = (expected: string | null, actual: unknown): boolean => {
  if (expected === null) return true;
  if (typeof actual !== "string") return false;
  return actual.toLowerCase().includes(expected.toLowerCase());
};
const eqIsoDate = (expected: string | null, actual: unknown): boolean => {
  if (expected === null) return true;
  return typeof actual === "string" && actual.slice(0, 10) === expected;
};
const eqMoney = (expected: number | null, actual: unknown): boolean => {
  if (expected === null) return true;
  if (typeof actual !== "number") return false;
  const tol = Math.max(0.05 * Math.abs(expected), 1);
  return Math.abs(actual - expected) <= tol;
};

interface FieldScore { tp: number; fp: number; fn: number; tn: number }
const blankScore = (): FieldScore => ({ tp: 0, fp: 0, fn: 0, tn: 0 });

const scores: Record<string, FieldScore> = {
  claim_number:         blankScore(),
  claimant_name:        blankScore(),
  policy_number:        blankScore(),
  incident_date:        blankScore(),
  incident_description: blankScore(),
  accident_location:    blankScore(),
  demand_total:         blankScore(),
};

function score(field: keyof typeof scores, expected: unknown, actual: unknown, matches: boolean) {
  const s = scores[field];
  const hasExpected = expected !== null && expected !== undefined;
  const hasActual   = actual   !== null && actual   !== undefined && actual !== "";
  if (hasExpected && hasActual && matches)        s.tp++;
  else if (hasExpected && hasActual && !matches)  s.fp++;
  else if (hasExpected && !hasActual)             s.fn++;
  else if (!hasExpected && hasActual)             s.fp++; // model invented a value
  else                                            s.tn++;
}

let failures = 0;
console.log(`Running golden-set eval against ${golden.length} claims (F1 threshold: ${THRESHOLD})\n`);

for (const g of golden) {
  const { data: c } = await supabase
    .from("claims")
    .select("id, claim_number, claimant_name, policy_number, incident_date, ai_synthesis")
    .eq("id", g.claim_id)
    .maybeSingle();
  if (!c) {
    console.error(`  ⚠️  golden claim_id ${g.claim_id} not in DB — skipping`);
    continue;
  }
  const syn = (c.ai_synthesis as Record<string, unknown>) ?? {};
  const claim = {
    claim_number:         (syn.claim_number ?? c.claim_number) as unknown,
    claimant_name:        (syn.claimant_name ?? c.claimant_name) as unknown,
    policy_number:        (syn.policy_number ?? c.policy_number) as unknown,
    incident_date:        (syn.incident_date ?? c.incident_date) as unknown,
    incident_description: syn.incident_description as unknown,
    accident_location:    syn.accident_location as unknown,
    demand_total:         syn.demand_total as unknown,
  };

  score("claim_number",         g.expected.claim_number,         claim.claim_number,         eqString(g.expected.claim_number ?? null, claim.claim_number));
  score("claimant_name",        g.expected.claimant_name,        claim.claimant_name,        eqString(g.expected.claimant_name ?? null, claim.claimant_name));
  score("policy_number",        g.expected.policy_number,        claim.policy_number,        eqString(g.expected.policy_number ?? null, claim.policy_number));
  score("incident_date",        g.expected.incident_date,        claim.incident_date,        eqIsoDate(g.expected.incident_date ?? null, claim.incident_date));
  score("incident_description", g.expected.incident_description, claim.incident_description, containsString(g.expected.incident_description ?? null, claim.incident_description));
  score("accident_location",    g.expected.accident_location,    claim.accident_location,    containsString(g.expected.accident_location ?? null, claim.accident_location));
  score("demand_total",         g.expected.demand_total,         claim.demand_total,         eqMoney(g.expected.demand_total ?? null, claim.demand_total));
}

console.log("Field-level results:");
console.log("field                  precision  recall  F1");
console.log("------                 ---------  ------  ----");
for (const [field, s] of Object.entries(scores)) {
  const precision = s.tp + s.fp > 0 ? s.tp / (s.tp + s.fp) : 1;
  const recall    = s.tp + s.fn > 0 ? s.tp / (s.tp + s.fn) : 1;
  const f1        = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const flag      = f1 < THRESHOLD ? "  ❌ BELOW THRESHOLD" : "";
  console.log(`${field.padEnd(22)} ${precision.toFixed(2).padStart(8)}   ${recall.toFixed(2).padStart(5)}   ${f1.toFixed(2)}${flag}`);
  if (f1 < THRESHOLD) failures++;
}

if (failures > 0) {
  console.error(`\n${failures} field(s) below F1 threshold ${THRESHOLD} — regression gate FAILED.`);
  Deno.exit(1);
}
console.log("\n✅ all fields meet threshold");
