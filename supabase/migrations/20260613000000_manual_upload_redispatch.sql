-- Broaden the stuck-pending watchdog to cover manually-uploaded documents.
--
-- Manual uploads (New Analysis screen) create claim_documents with
-- source='manual', processing_status='pending', then the browser calls
-- process-uploaded-claim to dispatch analyze. If that dispatch is lost (browser
-- closed first, or a 429), the doc would sit 'pending' forever because the
-- original watchdog only re-dispatched source='imageright'. Broadening the
-- source filter to ('imageright','manual') makes manual processing
-- browser-independent: any straggler is re-dispatched within ~10 minutes.
--
-- Same function the existing every-5-min cron already calls (see
-- 20260602010000_imageright_settings_table.sql) — only the WHERE source filter
-- changes. No new cron, no other behavior change.

CREATE OR REPLACE FUNCTION public.imageright_redispatch_stuck_pending()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url    text := public.imageright_setting('analyze_document_url');
  v_key    text := public.imageright_setting('service_role_key');
  v_stale  interval := interval '10 minutes';
  r        record;
BEGIN
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT id
    FROM claim_documents
    WHERE source IN ('imageright', 'manual')
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
