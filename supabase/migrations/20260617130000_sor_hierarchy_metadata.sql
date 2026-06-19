-- Sor hierarchy metadata on claim_documents.
--
-- The SOAP proxy already fetches the full File → Folder → Document → Page
-- hierarchy, but the pull path only persisted file_name + document_type + IDs.
-- These additive columns preserve the folder structure, the Sor document
-- type code/date/page-count, and the per-page manifest so the portal can
-- (a) render a Folder → Document → Page tree that mirrors Sor, and
-- (b) build layered citations (folder › document › page).
--
-- All columns are nullable and additive — manual uploads simply leave them NULL.
-- No backfill: re-pulling a claim from Sor repopulates them.

ALTER TABLE public.claim_documents
  -- Folder this document lives under (denormalized; the tree is rebuilt
  -- client-side by grouping on sor_folder_path).
  ADD COLUMN IF NOT EXISTS sor_folder_id BIGINT,
  ADD COLUMN IF NOT EXISTS sor_folder_name TEXT,
  -- Ordered root → immediate-parent chain, e.g. [{"id":3001,"name":"Claimant"}].
  -- name-only entries are acceptable when ids aren't exposed.
  ADD COLUMN IF NOT EXISTS sor_folder_path JSONB,
  -- Short Sor document-type code (ObjType.Name), e.g. "BIDO"/"POLDEM"/"SG11".
  ADD COLUMN IF NOT EXISTS sor_document_type_code TEXT,
  -- The document's intrinsic Sor date (DocumentDate), distinct from
  -- sor_last_modified.
  ADD COLUMN IF NOT EXISTS sor_document_date TIMESTAMPTZ,
  -- Sor-reported page count for the source document (the "page collection"
  -- size shown in the desktop client).
  ADD COLUMN IF NOT EXISTS sor_page_count INTEGER,
  -- Per-page manifest: [{ "n": 1, "irPageId": 5001, "format": "TIFF", "rendered": true }, ...]
  -- n = 1-based ordinal in the merged PDF (rendered pages only); non-rendered
  -- pages (audio/video/office omitted from the PDF) carry rendered=false, n=null.
  ADD COLUMN IF NOT EXISTS sor_pages JSONB,
  -- Processing tier, set at pull from the type code: 'full' = full 6-pass +
  -- grounding; 'light' = extraction only, grounding skipped (declarations,
  -- statements, routine correspondence). Drives analyze-claim-document.
  ADD COLUMN IF NOT EXISTS sor_processing_tier TEXT;

-- Constrain the tier to known values (self-documenting; nullable for manual docs).
ALTER TABLE public.claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_sor_tier_check;
ALTER TABLE public.claim_documents
  ADD CONSTRAINT claim_documents_sor_tier_check
  CHECK (sor_processing_tier IS NULL OR sor_processing_tier IN ('full', 'light'));

-- Allow grounding_status to record a tier-based skip (light-tier docs never run
-- grounding), alongside the existing oversize skip.
ALTER TABLE public.claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_grounding_status_check;
ALTER TABLE public.claim_documents
  ADD CONSTRAINT claim_documents_grounding_status_check
  CHECK (grounding_status IN ('not_run', 'passed', 'partial', 'failed', 'skipped_oversize', 'skipped_light'));

-- Index the folder name for the occasional folder-scoped query (cheap, partial).
CREATE INDEX IF NOT EXISTS claim_documents_sor_folder_idx
  ON public.claim_documents (claim_id, sor_folder_name)
  WHERE sor_folder_name IS NOT NULL;

COMMENT ON COLUMN public.claim_documents.sor_folder_path IS
  'Ordered root→parent folder chain [{id,name}] from Sor; used to rebuild the document tree and layered citations.';
COMMENT ON COLUMN public.claim_documents.sor_pages IS
  'Per-page manifest [{n,irPageId,format,rendered}]; n is the 1-based merged-PDF page ordinal. Powers the per-page tree level + page-jump links.';
COMMENT ON COLUMN public.claim_documents.sor_processing_tier IS
  'full = full pipeline + grounding; light = extraction only, grounding skipped. Set at pull from the Sor document type code.';
