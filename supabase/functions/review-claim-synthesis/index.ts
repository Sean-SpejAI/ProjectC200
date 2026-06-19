// Synthesis-review pass — runs after synthesize-claim-extraction.
//
// Two responsibilities:
//   1. Gap fill — inspect claims.ai_synthesis.adjusterPortion for null/blank
//      fields that should be populated given what docs are on the claim,
//      then lift values out of per-doc ai_analysis (no LLM call) to fill
//      them. Stamps _provenance.<field>.source so downstream code can tell
//      review-pass values from original-synthesis values.
//   2. Dedupe — collapse duplicate entries inside synthesis arrays
//      (injuries, provider_visit_details, medicalBillBreakdown,
//      perInjuryGenerals) and strip cross-field narrative duplication.
//
// Idempotent. Safe to re-run any time. Triggered:
//   - automatically by synthesize-claim-extraction on success
//   - manually for batch audits: curl ... -d '{"claimId":"..."}' (service-role bearer)

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";
import { diffAnalysis } from "../_shared/analysis-diff.ts";
import {
  type AiSynthesis,
  type PerDocAnalysis,
  type ProvenanceEntry,
  dedupeNarrativeCrossField,
  dedupeSynthesisArrays,
  findGaps,
  liftFromDocs,
} from "../_shared/synthesis-review.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "X-Content-Type-Options": "nosniff",
};

interface RequestBody {
  claimId?: string;
}

function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const scannerEarly = scannerShortCircuit(req, corsHeaders);
  if (scannerEarly) return scannerEarly;

  let body: RequestBody = {};
  try { body = await req.json(); } catch { /* empty body returns 400 below */ }
  const claimId = body.claimId;
  if (!claimId) {
    return new Response(JSON.stringify({ error: "claimId required" }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const supabase = adminClient();

  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .select("id, ai_synthesis, synthesis_status")
    .eq("id", claimId)
    .single();
  if (claimErr || !claim) {
    return new Response(JSON.stringify({ error: "claim_not_found", detail: claimErr?.message }), {
      status: 404, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
  if (claim.synthesis_status !== "completed") {
    return new Response(JSON.stringify({ skipped: "synthesis_not_completed", status: claim.synthesis_status }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
  if (!claim.ai_synthesis || typeof claim.ai_synthesis !== "object") {
    return new Response(JSON.stringify({ skipped: "no_synthesis" }), {
      status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const { data: docRows, error: docsErr } = await supabase
    .from("claim_documents")
    .select("imageright_document_id, document_type, ai_analysis")
    .eq("claim_id", claimId)
    .in("processing_status", ["completed", "needs_review"]);
  if (docsErr) {
    return new Response(JSON.stringify({ error: "docs_fetch_failed", detail: docsErr.message }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const docs: PerDocAnalysis[] = (docRows ?? []).map((r) => ({
    doc_id: String(r.imageright_document_id ?? ""),
    document_type: r.document_type as string | null,
    ai_analysis: (r.ai_analysis ?? null) as Record<string, unknown> | null,
  }));

  const synthesis = claim.ai_synthesis as AiSynthesis;

  // 1. Gap detection + lift
  const gaps = findGaps(synthesis, docs);
  const { patch, provenance } = liftFromDocs(gaps, docs);

  // Merge lifted patch into adjusterPortion
  const nextAp = { ...(synthesis.adjusterPortion ?? {}), ...patch };
  let next: AiSynthesis = { ...synthesis, adjusterPortion: nextAp };

  // 2. Dedupe arrays (c)
  const dedupedArrays = dedupeSynthesisArrays(next);
  next = dedupedArrays.patched;

  // 3. Dedupe cross-field narratives (d)
  const dedupedNarrative = dedupeNarrativeCrossField(next);
  next = dedupedNarrative.patched;

  // 4. Stamp provenance into the synthesis JSON itself
  if (Object.keys(provenance).length > 0) {
    const existing = (next._provenance ?? {}) as Record<string, ProvenanceEntry>;
    next._provenance = { ...existing, ...provenance };
  }

  // Write back only if anything actually changed
  const changed =
    Object.keys(patch).length > 0 ||
    dedupedArrays.removed.injuries > 0 ||
    dedupedArrays.removed.provider_visit_details > 0 ||
    dedupedArrays.removed.medicalBillBreakdown > 0 ||
    dedupedArrays.removed.perInjuryGenerals > 0 ||
    dedupedNarrative.notes.length > 0;

  if (changed) {
    const { error: upErr } = await supabase
      .from("claims")
      .update({ ai_synthesis: next })
      .eq("id", claimId);
    if (upErr) {
      return new Response(JSON.stringify({ error: "update_failed", detail: upErr.message }), {
        status: 500, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Record the review-pass's own changes in the field audit trail (kind='ai'),
    // so its lift/dedupe mutations are visible AND aren't later mis-attributed to
    // the next synthesis run's diff. Best-effort; never fail the pass on this.
    try {
      const reviewChanges = diffAnalysis(synthesis, next);
      if (reviewChanges.length > 0) {
        await supabase.from("claim_field_audit").insert(
          reviewChanges.map((c) => ({
            claim_id: claimId,
            field_path: c.path,
            field_label: c.label,
            old_value: c.old ?? null,
            new_value: c.new ?? null,
            changed_by: null,
            changed_by_kind: "ai" as const,
          })),
        );
      }
    } catch (e) {
      console.warn("[review-claim-synthesis] audit diff skipped:", e instanceof Error ? e.message : String(e));
    }
  }

  return new Response(JSON.stringify({
    success: true,
    claimId,
    docs_considered: docs.length,
    gaps_detected: gaps.map((g) => g.field),
    fields_lifted: Object.keys(patch),
    dedupe_removed: dedupedArrays.removed,
    narrative_notes: dedupedNarrative.notes,
    changed,
  }), {
    status: 200, headers: { "Content-Type": "application/json", ...corsHeaders },
  });
});
