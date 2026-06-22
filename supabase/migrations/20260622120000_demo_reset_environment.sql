-- Demo "Reset Environment" support.
--
-- Powers the admin-panel "Reset Environment" button (edge function
-- `admin-reset-environment`). Lets an operator snapshot the clean demo state
-- (the 3 pre-loaded, de-identified claims + their documents + storage objects)
-- as a BASELINE, then later wipe any demo-session changes — most importantly
-- the demand packet a presenter uploads live during a demo — and restore
-- exactly that baseline.
--
-- Design notes:
--  * The baseline is DATA, not schema: it captures whatever is currently loaded
--    into THIS environment. So it lives in a runtime table (demo_baseline), not
--    a migration seed, and is (re)captured via capture_demo_baseline().
--  * All AI output the demo renders lives in claims.ai_synthesis and
--    claim_documents.ai_analysis (verified: the document_analysis_results /
--    extraction_passes / processing_* child tables are empty in this env). So a
--    full delete-and-reseed of claims + claim_documents loses nothing — the FK
--    cascade clears any child rows and we reinsert the exact snapshot rows
--    (same ids, so file_url ↔ storage paths stay aligned).
--  * Storage files are NOT deleted in SQL (deleting storage.objects rows would
--    orphan the backing files). This function only COMPUTES which objects are
--    demo-time extras; the edge function removes them through the Storage API.
--  * The functions are SECURITY DEFINER and granted to service_role ONLY — the
--    edge function calls them with the service-role key after it has verified
--    the caller is an admin. anon/authenticated cannot invoke them directly.

-- ---------------------------------------------------------------------------
-- Baseline snapshot store. One row per capture; the latest row is the active
-- baseline. Each row holds the full claims + claim_documents rows (as jsonb)
-- and the list of storage object keys present at capture time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.demo_baseline (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_by     UUID,
  note            TEXT,
  claims          JSONB NOT NULL,
  claim_documents JSONB NOT NULL,
  storage_keys    JSONB NOT NULL,
  claims_count    INTEGER NOT NULL,
  documents_count INTEGER NOT NULL,
  storage_count   INTEGER NOT NULL
);

-- Snapshot table is admin/service-role only. RLS on with no anon/authenticated
-- policies means PostgREST exposes nothing; service_role bypasses RLS.
ALTER TABLE public.demo_baseline ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- capture_demo_baseline: snapshot the current environment as a new baseline.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capture_demo_baseline(
  p_note TEXT DEFAULT NULL,
  p_captured_by UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
DECLARE
  v_id     UUID;
  v_claims JSONB;
  v_docs   JSONB;
  v_keys   JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(c.*) ORDER BY c.created_at), '[]'::jsonb)
    INTO v_claims FROM public.claims c;

  SELECT COALESCE(jsonb_agg(to_jsonb(d.*) ORDER BY d.uploaded_at), '[]'::jsonb)
    INTO v_docs FROM public.claim_documents d;

  SELECT COALESCE(jsonb_agg(o.name ORDER BY o.name), '[]'::jsonb)
    INTO v_keys FROM storage.objects o WHERE o.bucket_id = 'claim-documents';

  INSERT INTO public.demo_baseline
    (captured_by, note, claims, claim_documents, storage_keys,
     claims_count, documents_count, storage_count)
  VALUES
    (p_captured_by, p_note, v_claims, v_docs, v_keys,
     jsonb_array_length(v_claims), jsonb_array_length(v_docs), jsonb_array_length(v_keys))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'baseline_id', v_id,
    'captured_at', now(),
    'claims', jsonb_array_length(v_claims),
    'documents', jsonb_array_length(v_docs),
    'storage_objects', jsonb_array_length(v_keys)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- demo_reset_status: current counts vs. the active baseline (for the UI).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.demo_reset_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
DECLARE
  v_base public.demo_baseline;
  v_result JSONB;
BEGIN
  SELECT * INTO v_base FROM public.demo_baseline ORDER BY captured_at DESC LIMIT 1;

  v_result := jsonb_build_object(
    'current', jsonb_build_object(
      'claims', (SELECT count(*) FROM public.claims),
      'documents', (SELECT count(*) FROM public.claim_documents),
      'storage_objects', (SELECT count(*) FROM storage.objects WHERE bucket_id = 'claim-documents')
    )
  );

  IF v_base.id IS NULL THEN
    v_result := v_result || jsonb_build_object('baseline', NULL);
  ELSE
    v_result := v_result || jsonb_build_object('baseline', jsonb_build_object(
      'id', v_base.id,
      'captured_at', v_base.captured_at,
      'note', v_base.note,
      'claims', v_base.claims_count,
      'documents', v_base.documents_count,
      'storage_objects', v_base.storage_count
    ));
  END IF;

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- reset_demo_environment: restore the latest baseline. Wipes all claims
-- (cascade clears claim_documents + any child rows), reinserts the snapshot
-- rows verbatim, and returns the set of storage objects that are NOT part of
-- the baseline (demo-time uploads) for the edge function to delete via the
-- Storage API.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_demo_environment()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
DECLARE
  v_base           public.demo_baseline;
  v_claims_before  INTEGER;
  v_docs_before    INTEGER;
  v_extras         JSONB;
BEGIN
  SELECT * INTO v_base FROM public.demo_baseline ORDER BY captured_at DESC LIMIT 1;
  IF v_base.id IS NULL THEN
    RAISE EXCEPTION 'no_baseline_captured'
      USING HINT = 'Capture a baseline before resetting.';
  END IF;

  SELECT count(*) INTO v_claims_before FROM public.claims;
  SELECT count(*) INTO v_docs_before   FROM public.claim_documents;

  -- Compute demo-time storage extras BEFORE touching anything else.
  SELECT COALESCE(jsonb_agg(o.name ORDER BY o.name), '[]'::jsonb)
    INTO v_extras
    FROM storage.objects o
   WHERE o.bucket_id = 'claim-documents'
     AND o.name NOT IN (SELECT jsonb_array_elements_text(v_base.storage_keys));

  -- Wipe + reseed. Deleting claims cascades to claim_documents and all their
  -- child rows. Reinsert claims first (FK parent), then documents.
  -- NB: the always-true WHERE is required — Supabase loads the `safeupdate`
  -- extension on the PostgREST/service-role connection, which rejects a bare
  -- DELETE (SQLSTATE 21000 "DELETE requires a WHERE clause").
  DELETE FROM public.claims WHERE id IS NOT NULL;
  INSERT INTO public.claims
    SELECT * FROM jsonb_populate_recordset(NULL::public.claims, v_base.claims);
  INSERT INTO public.claim_documents
    SELECT * FROM jsonb_populate_recordset(NULL::public.claim_documents, v_base.claim_documents);

  RETURN jsonb_build_object(
    'baseline_id', v_base.id,
    'baseline_captured_at', v_base.captured_at,
    'claims_before', v_claims_before,
    'documents_before', v_docs_before,
    'claims_restored', v_base.claims_count,
    'documents_restored', v_base.documents_count,
    'extra_storage_keys', v_extras
  );
END;
$$;

-- Lock down execution: service_role only (the edge function authenticates the
-- admin caller, then invokes these with the service-role key). Supabase's
-- default privileges grant EXECUTE on new public functions to anon +
-- authenticated EXPLICITLY (not via PUBLIC), so revoke from those roles too —
-- otherwise any logged-in user could call reset_demo_environment() directly
-- through PostgREST RPC and wipe the demo, bypassing the admin gate.
REVOKE ALL ON FUNCTION public.capture_demo_baseline(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.demo_reset_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reset_demo_environment() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_demo_baseline(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.demo_reset_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.reset_demo_environment() TO service_role;
