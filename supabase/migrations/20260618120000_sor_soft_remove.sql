-- Soft-remove marker for Sor documents that no longer exist in the source.
--
-- The daily reconcile pass re-reads a claim's Sor tree and diffs it
-- against our stored rows. A document that was deleted/cut in Sor (absent
-- from the fresh tree) is SOFT-removed here rather than hard-deleted: it leaves
-- the document tree + is excluded from synthesis, but the row + its extraction
-- are preserved (auditable) and the mark is reversible — a later pull that finds
-- the docId again clears it back to NULL.
--
-- Deliberately NOT processing_status='superseded': the portal's document-tree
-- filter intentionally KEEPS superseded rows that carry an sor_document_id
-- (resplit page-collection heads), which every Sor doc has. A separate
-- timestamp is orthogonal to processing state, auditable, and reversible.

ALTER TABLE public.claim_documents
  ADD COLUMN IF NOT EXISTS sor_removed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.claim_documents.sor_removed_at IS
  'Set when a reconcile pass finds this Sor document is no longer present in the source. Soft-removed: excluded from the tree + synthesis, preserved for audit, cleared on re-appearance.';

-- Partial index over the common "active rows for this claim" lookup used by the
-- reconcile diff, the synthesis doc query, and the portal fetch.
CREATE INDEX IF NOT EXISTS claim_documents_active_idx
  ON public.claim_documents (claim_id)
  WHERE sor_removed_at IS NULL;
