-- Field-level audit trail + reconciliation approval gate.
--
-- (1) claim_field_audit: one row per field change (human OR AI) with old/new
--     value, actor, and timestamp. Powers the per-field "Audit Trail" view and
--     the human-edit signal that gates reconciliation.
-- (2) claims gains a human-edit marker + a pending_reconcile holding area, and
--     synthesis_status learns 'awaiting_approval'.

-- ---- 1. Audit table -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.claim_field_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  -- Dot/indexed path into ai_synthesis, e.g. "headerInfo.demandAmount" or
  -- "medicalBillBreakdown[2].amountBilled".
  field_path TEXT NOT NULL,
  -- Human-readable label for the field (for display alongside the path).
  field_label TEXT,
  old_value JSONB,
  new_value JSONB,
  -- Null for AI writes (UI renders "AI Analysis"); the user id for human edits.
  changed_by UUID REFERENCES auth.users(id),
  changed_by_kind TEXT NOT NULL DEFAULT 'human' CHECK (changed_by_kind IN ('human','ai')),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claim_field_audit_lookup_idx
  ON public.claim_field_audit (claim_id, field_path, changed_at DESC);

ALTER TABLE public.claim_field_audit ENABLE ROW LEVEL SECURITY;

-- Admins + claims managers may read the audit trail. Inserts happen via edge
-- functions using the service role (which bypasses RLS), so there is no INSERT
-- policy (clients cannot write audit rows directly).
DROP POLICY IF EXISTS "Admins and managers can view field audit" ON public.claim_field_audit;
CREATE POLICY "Admins and managers can view field audit"
  ON public.claim_field_audit FOR SELECT
  USING (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.has_role(auth.uid(), 'claims_manager'::public.app_role)
  );

-- ---- 2. claims: human-edit marker + pending reconcile ---------------------
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS synthesis_human_edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS synthesis_human_edited_by UUID REFERENCES auth.users(id),
  -- A reconcile detected on a human-edited claim, held for approval:
  -- { mode:'incremental'|'full', diff:{added,modified,removed,folderChanged,...}, detected_at }
  ADD COLUMN IF NOT EXISTS pending_reconcile JSONB;

-- Allow synthesis_status to record a held reconcile awaiting human approval.
ALTER TABLE public.claims DROP CONSTRAINT IF EXISTS claims_synthesis_status_check;
ALTER TABLE public.claims
  ADD CONSTRAINT claims_synthesis_status_check
  CHECK (synthesis_status IN ('not_run','pending','running','completed','failed','skipped','awaiting_approval'));

COMMENT ON TABLE public.claim_field_audit IS
  'Field-level change history for a claim analysis (human edits + AI writes). Powers the per-field Audit Trail and the human-edit reconcile gate.';
COMMENT ON COLUMN public.claims.synthesis_human_edited_at IS
  'Set when a human saved an edit to ai_synthesis; cleared when an approved reconcile re-runs. Non-null => reconcile must wait for approval.';
COMMENT ON COLUMN public.claims.pending_reconcile IS
  'A reconcile detected on a human-edited claim, held for approval: {mode, diff, detected_at}. Cleared on approve/reject.';
