-- Pre-SOAP cleanup. REST left pending_content rows for Sor docs that
-- never got binary content (page-content endpoint was returning HTTP 500).
-- Under the SOAP redesign each document becomes one PDF (not per-page), so
-- those page-shaped rows are obsolete. Drop them; the admin can re-pull any
-- claim from the new "Pull one claim" UI, and the next daily diff will
-- reingest anything that was actively modified.
--
-- No storage cleanup needed — pending_content rows have file_url = NULL
-- (binary was never downloaded).

DELETE FROM public.claim_documents
WHERE source = 'sor'
  AND processing_status = 'pending_content';
