-- Make the `claim-documents` bucket PRIVATE.
--
-- These PDFs hold claimant PII + medical records, but the bucket was created
-- with `public = true` and a `public`-role INSERT policy — so anyone with a
-- `/storage/v1/object/public/claim-documents/...` URL could read a document
-- with no authentication, and anon could upload. This locks it down:
--   * bucket -> private (kills the public read path),
--   * reads are service-role only (no SELECT policy) — the browser never reads
--     storage directly; PDFs are served via the `sign-claim-document` edge
--     function, which verifies the user's JWT then mints a 1-hour signed URL,
--   * writes (upload/delete) restricted to authenticated users (manual uploads
--     go browser->storage directly; the New-Analysis delete flow removes them).
--
-- Also backfills existing `claim_documents.file_url` values from full public
-- URLs to bare storage paths (the new canonical form). The path helpers tolerate
-- both, but normalising removes dead public URLs.

-- 1) Bucket private.
update storage.buckets set public = false where id = 'claim-documents';

-- 2) Replace the over-broad public INSERT policy with authenticated-only
--    write policies. No SELECT policy => only service_role can read (it bypasses
--    RLS); anon and authenticated browser clients cannot read storage directly.
drop policy if exists "Allow public upload to claim-documents" on storage.objects;

drop policy if exists "claim-documents authenticated insert" on storage.objects;
create policy "claim-documents authenticated insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'claim-documents');

drop policy if exists "claim-documents authenticated update" on storage.objects;
create policy "claim-documents authenticated update"
  on storage.objects for update to authenticated
  using (bucket_id = 'claim-documents')
  with check (bucket_id = 'claim-documents');

drop policy if exists "claim-documents authenticated delete" on storage.objects;
create policy "claim-documents authenticated delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'claim-documents');

-- 3) Backfill file_url: full public/signed URL -> bare storage path. Rows that
--    already hold a bare path (no "/claim-documents/" segment) are untouched, so
--    this is idempotent.
update claim_documents
set file_url = regexp_replace(
                 split_part(file_url, '?', 1),                 -- drop any ?token=...
                 '^.*/object/(public|sign)/claim-documents/', '')
where file_url like '%/object/%/claim-documents/%';
