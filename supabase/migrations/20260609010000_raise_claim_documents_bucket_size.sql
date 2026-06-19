-- Raise the `claim-documents` Storage bucket file_size_limit so 250 MB
-- client PDFs (some ImageRight bundles run that large) can be uploaded.
--
-- Background: the bucket was created in 20260331164457_* with no explicit
-- `file_size_limit`, which means Supabase Storage applies the default 50 MB
-- per-file cap. Uploads above that cap fail with "Payload too large", which
-- shows up as a storage-upload error in fetch-imageright-document.
--
-- 300 MB matches MAX_FILE_SIZE in `_shared/types.ts` and leaves a 50 MB
-- headroom above the largest known client doc (250 MB). Vertex AI's gs://
-- fileData path supports up to 2 GB, so the bottleneck is no longer Storage
-- or Vertex — it's now Edge worker memory, which is handled separately by
-- streaming the upload (fetch-imageright-document) instead of buffering.

UPDATE storage.buckets
SET file_size_limit = 314572800  -- 300 * 1024 * 1024
WHERE id = 'claim-documents';
