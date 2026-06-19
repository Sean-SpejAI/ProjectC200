-- Fix the imageright_redispatch_stuck_pending watchdog to read its settings
-- (analyze function URL + service role key) from the public.imageright_settings
-- table instead of `current_setting('app.settings.*')` GUCs.
--
-- The GUC-based version (originally in 20260602000000_imageright_watchdogs.sql)
-- has been a silent no-op since deploy because no `app.settings.analyze_document_url`
-- or `app.settings.service_role_key` GUC is set at the database level in this
-- Supabase environment. Confirmed 2026-06-08:
--   SELECT name, setting, source FROM pg_settings WHERE name LIKE 'app%';
--   → returns only application_name; no app.settings.* defined anywhere.
--
-- The function's `IF v_url IS NULL OR v_key IS NULL THEN RETURN; END IF;` guard
-- (intentional graceful fallback) turned that into a silent stall — cron.job_run_details
-- showed every cycle as `succeeded` with `return_message: '1 row'`, but PERFORM
-- net.http_post was never reached. We only noticed during a 1162-doc backfill in
-- June 2026 when re-flipped docs sat in `pending` indefinitely.
--
-- public.imageright_settings is the table the imageright-sync orchestrator
-- already uses for the same values (see 20260602060000_*_imageright_settings.sql
-- or similar). The values are: analyze_document_url, service_role_key,
-- imageright_sync_url. Reading from this table works in any session, no GUC needed.
--
-- KNOWN: imageright_redispatch_stuck_runs (the SIBLING watchdog in the same
-- 20260602000000 migration) AND the integration cron trigger in
-- 20260518021407_imageright_integration.sql ALSO use the broken GUC pattern.
-- Those should be audited and migrated to the table-based source in a follow-up
-- — they're out of scope for this targeted fix.

CREATE OR REPLACE FUNCTION public.imageright_redispatch_stuck_pending()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url    text;
  v_key    text;
  v_stale  interval := interval '10 minutes';
  r        record;
BEGIN
  SELECT value INTO v_url FROM public.imageright_settings WHERE name = 'analyze_document_url';
  SELECT value INTO v_key FROM public.imageright_settings WHERE name = 'service_role_key';

  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN;  -- settings not wired up; no-op
  END IF;

  FOR r IN
    SELECT id
    FROM claim_documents
    WHERE source = 'imageright'
      AND processing_status = 'pending'
      AND uploaded_at < now() - v_stale
    ORDER BY uploaded_at ASC
    LIMIT 5
  LOOP
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body := jsonb_build_object('documentId', r.id, 'async', true)
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.imageright_redispatch_stuck_pending() FROM PUBLIC, anon, authenticated;
