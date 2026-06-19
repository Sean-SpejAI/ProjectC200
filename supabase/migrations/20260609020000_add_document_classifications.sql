-- Add `document_classifications` JSONB column to claim_documents for the
-- Pass 0 classifier (Phase 1.1 of the quality plan).
--
-- Shape: array of {type, pageStart, pageEnd, confidence}.
-- Example:
--   [
--     {"type": "correspondence", "pageStart": 1,  "pageEnd": 19, "confidence": 0.95},
--     {"type": "medical_record", "pageStart": 20, "pageEnd": 45, "confidence": 0.88},
--     {"type": "bills",          "pageStart": 46, "pageEnd": 60, "confidence": 0.91}
--   ]
--
-- The existing `document_type` TEXT column remains as the PRIMARY classification
-- (entry with the largest page coverage) for back-compat with the UI + the
-- Sor metadata override. New code uses `document_classifications` for
-- multi-label type-aware required-field rules; old code reading `document_type`
-- keeps working.

ALTER TABLE public.claim_documents
  ADD COLUMN IF NOT EXISTS document_classifications JSONB DEFAULT NULL;

-- Partial index for finding unclassified docs during backfill. Cheap to drop.
CREATE INDEX IF NOT EXISTS claim_documents_unclassified_idx
  ON public.claim_documents (source, processing_status)
  WHERE document_classifications IS NULL;

COMMENT ON COLUMN public.claim_documents.document_classifications IS
  'Pass 0 classifier output: array of {type, pageStart, pageEnd, confidence}. NULL = not yet classified. Primary type lives in document_type for back-compat.';
