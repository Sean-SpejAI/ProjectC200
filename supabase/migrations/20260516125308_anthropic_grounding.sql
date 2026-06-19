-- Anthropic grounding & evaluation pass — backend schema
--
-- After Gemini extracts the report, Claude (via Azure AI Foundry Anthropic
-- Messages proxy) verifies each section against the source PDF and can
-- request a targeted re-extraction. This migration adds the columns the
-- edge function needs to record what was checked, what verdict came back,
-- and how many repair iterations ran — without disturbing the existing
-- completeness scoring that measures presence rather than correctness.

-- Per-document grounding state. All columns nullable / defaulted so existing
-- rows remain valid; defaults match "grounding never ran" semantics.
ALTER TABLE public.claim_documents
  ADD COLUMN IF NOT EXISTS grounding_status TEXT NOT NULL DEFAULT 'not_run',
  ADD COLUMN IF NOT EXISTS grounding_score DECIMAL(3,2),
  ADD COLUMN IF NOT EXISTS grounding_iterations INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grounding_evaluation JSONB;

-- Constrain grounding_status to known values. Keeps the column self-documenting
-- and prevents typos from the edge function silently writing garbage.
ALTER TABLE public.claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_grounding_status_check;
ALTER TABLE public.claim_documents
  ADD CONSTRAINT claim_documents_grounding_status_check
  CHECK (grounding_status IN ('not_run', 'passed', 'partial', 'failed', 'skipped_oversize'));

-- processing_status is a free-form text column today (no enum). Add a check
-- constraint so 'needs_review' is the only new allowed value we add — the
-- rest stay as they are. Frontend treats 'needs_review' as a completed-but-
-- flagged state (data saved, grounding could not certify).
ALTER TABLE public.claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_processing_status_check;
ALTER TABLE public.claim_documents
  ADD CONSTRAINT claim_documents_processing_status_check
  CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed', 'needs_review'));

-- Per-pass audit columns. Pass numbers 5/6/7 represent grounding iterations.
ALTER TABLE public.extraction_passes
  ADD COLUMN IF NOT EXISTS evaluator_verdict JSONB,
  ADD COLUMN IF NOT EXISTS triggered_by TEXT;

-- Index for filtering on needs_review in queue queries.
CREATE INDEX IF NOT EXISTS idx_claim_documents_needs_review
  ON public.claim_documents(processing_status)
  WHERE processing_status = 'needs_review';
