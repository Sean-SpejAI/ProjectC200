-- Manual New-Analysis uploads of large, multi-document claims (e.g. a 14-part,
-- >1 GB demand packet) silently froze: every document hung in 'processing'
-- forever and the Review Queue progress bar sat at 0% with no real-time
-- movement. Two root causes:
--
--   1. process-uploaded-claim dispatched analyze-claim-document for ALL of a
--      claim's pending docs at once. The big files (200-280 MB) are buffered
--      whole in the Edge worker, so several at once OOM-kill the workers before
--      their catch block can mark the doc 'failed' — leaving 'processing' with
--      no error and no recovery.
--
--   2. sor_reset_zombie_processing — the watchdog that resets docs stuck
--      in 'processing' — only matched source='sor'. Manually-uploaded
--      docs were never rescued, so they stayed 'processing' indefinitely. (The
--      *pending* watchdog was already broadened to 'manual' in
--      20260613000000; this 'processing' one was missed.)
--
-- This migration fixes the recovery + concurrency at the DB/watchdog layer
-- (process-uploaded-claim is updated separately to stop the initial stampede):
--   - reset-zombie-processing now covers 'manual' as well as 'sor';
--   - redispatch now bounds MANUAL analyze jobs to a concurrency cap so a large
--     claim drains a few documents at a time instead of all at once. The
--     Sor path (small, server-streamed docs) keeps its original
--     behaviour.

-- 1) Rescue stuck 'processing' docs for manual uploads too.
CREATE OR REPLACE FUNCTION public.sor_reset_zombie_processing()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE claim_documents
  SET processing_status = 'pending',
      processing_started_at = NULL,
      processing_error = COALESCE(processing_error, '') ||
        CASE WHEN COALESCE(processing_error, '') = '' THEN '' ELSE ' | ' END ||
        'watchdog_reset: was processing for >30min without completion'
  WHERE source IN ('sor', 'manual')
    AND processing_status = 'processing'
    AND processing_started_at IS NOT NULL
    AND processing_started_at < now() - interval '30 minutes';
END;
$function$;

-- 2) Redispatch pending docs, but cap MANUAL concurrency so big files never
--    stampede the workers.
CREATE OR REPLACE FUNCTION public.sor_redispatch_stuck_pending()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_url        text := public.sor_setting('analyze_document_url');
  v_key        text := public.sor_setting('service_role_key');
  v_manual_cap int  := 3;     -- max manual analyze jobs in flight at once
  v_inflight   int;
  v_slots      int;
  r            record;
BEGIN
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN;
  END IF;

  -- Sor docs are small and streamed server-side — keep the original
  -- behaviour (up to 5 stale-pending docs per run, oldest first).
  FOR r IN
    SELECT id
    FROM claim_documents
    WHERE source = 'sor'
      AND processing_status = 'pending'
      AND uploaded_at < now() - interval '10 minutes'
    ORDER BY uploaded_at ASC
    LIMIT 5
  LOOP
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object('documentId', r.id, 'async', true)
    );
  END LOOP;

  -- Manual uploads can be hundreds of MB each. Only top the in-flight count up
  -- to the cap, smallest-first (quicker visible progress; big files deferred).
  -- The cap — not a long staleness delay — is what prevents the stampede, so we
  -- use a short staleness and let docs start promptly.
  SELECT count(*) INTO v_inflight
  FROM claim_documents
  WHERE source = 'manual' AND processing_status = 'processing';

  v_slots := v_manual_cap - v_inflight;
  IF v_slots > 0 THEN
    FOR r IN
      SELECT id
      FROM claim_documents
      WHERE source = 'manual'
        AND processing_status = 'pending'
        AND uploaded_at < now() - interval '90 seconds'
      ORDER BY file_size ASC NULLS FIRST, uploaded_at ASC
      LIMIT v_slots
    LOOP
      PERFORM net.http_post(
        url := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
        body := jsonb_build_object('documentId', r.id, 'async', true)
      );
    END LOOP;
  END IF;
END;
$function$;
