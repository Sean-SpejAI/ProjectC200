-- ImageRight hierarchy metadata on claim_documents.
--
-- The SOAP proxy already fetches the full File → Folder → Document → Page
-- hierarchy, but the pull path only persisted file_name + document_type + IDs.
-- These additive columns preserve the folder structure, the ImageRight document
-- type code/date/page-count, and the per-page manifest so the portal can
-- (a) render a Folder → Document → Page tree that mirrors ImageRight, and
-- (b) build layered citations (folder › document › page).
--
-- All columns are nullable and additive — manual uploads simply leave them NULL.
-- No backfill: re-pulling a claim from ImageRight repopulates them.

ALTER TABLE public.claim_documents
  -- Folder this document lives under (denormalized; the tree is rebuilt
  -- client-side by grouping on imageright_folder_path).
  ADD COLUMN IF NOT EXISTS imageright_folder_id BIGINT,
  ADD COLUMN IF NOT EXISTS imageright_folder_name TEXT,
  -- Ordered root → immediate-parent chain, e.g. [{"id":3001,"name":"Claimant"}].
  -- name-only entries are acceptable when ids aren't exposed.
  ADD COLUMN IF NOT EXISTS imageright_folder_path JSONB,
  -- Short ImageRight document-type code (ObjType.Name), e.g. "BIDO"/"POLDEM"/"SG11".
  ADD COLUMN IF NOT EXISTS imageright_document_type_code TEXT,
  -- The document's intrinsic ImageRight date (DocumentDate), distinct from
  -- imageright_last_modified.
  ADD COLUMN IF NOT EXISTS imageright_document_date TIMESTAMPTZ,
  -- ImageRight-reported page count for the source document (the "page collection"
  -- size shown in the desktop client).
  ADD COLUMN IF NOT EXISTS imageright_page_count INTEGER,
  -- Per-page manifest: [{ "n": 1, "irPageId": 5001, "format": "TIFF", "rendered": true }, ...]
  -- n = 1-based ordinal in the merged PDF (rendered pages only); non-rendered
  -- pages (audio/video/office omitted from the PDF) carry rendered=false, n=null.
  ADD COLUMN IF NOT EXISTS imageright_pages JSONB,
  -- Processing tier, set at pull from the type code: 'full' = full 6-pass +
  -- grounding; 'light' = extraction only, grounding skipped (declarations,
  -- statements, routine correspondence). Drives analyze-claim-document.
  ADD COLUMN IF NOT EXISTS imageright_processing_tier TEXT;

-- Constrain the tier to known values (self-documenting; nullable for manual docs).
ALTER TABLE public.claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_imageright_tier_check;
ALTER TABLE public.claim_documents
  ADD CONSTRAINT claim_documents_imageright_tier_check
  CHECK (imageright_processing_tier IS NULL OR imageright_processing_tier IN ('full', 'light'));

-- Allow grounding_status to record a tier-based skip (light-tier docs never run
-- grounding), alongside the existing oversize skip.
ALTER TABLE public.claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_grounding_status_check;
ALTER TABLE public.claim_documents
  ADD CONSTRAINT claim_documents_grounding_status_check
  CHECK (grounding_status IN ('not_run', 'passed', 'partial', 'failed', 'skipped_oversize', 'skipped_light'));

-- Index the folder name for the occasional folder-scoped query (cheap, partial).
CREATE INDEX IF NOT EXISTS claim_documents_imageright_folder_idx
  ON public.claim_documents (claim_id, imageright_folder_name)
  WHERE imageright_folder_name IS NOT NULL;

COMMENT ON COLUMN public.claim_documents.imageright_folder_path IS
  'Ordered root→parent folder chain [{id,name}] from ImageRight; used to rebuild the document tree and layered citations.';
COMMENT ON COLUMN public.claim_documents.imageright_pages IS
  'Per-page manifest [{n,irPageId,format,rendered}]; n is the 1-based merged-PDF page ordinal. Powers the per-page tree level + page-jump links.';
COMMENT ON COLUMN public.claim_documents.imageright_processing_tier IS
  'full = full pipeline + grounding; light = extraction only, grounding skipped. Set at pull from the ImageRight document type code.';
