-- Manual large-upload pipeline: break the zombie deadlock + raise throughput.
--
-- A 14-part demand packet (claim 264463), browser-split into 81 chunks of dense
-- scanned medical records (~30 MB / 25 pages each), hung at "77/81" for ~22 h and
-- never finished. Two problems, both fixed here:
--
--   1. DEADLOCK. A handful of the largest chunks reached 'processing', completed
--      early passes, then the 400 s Edge worker wall-clock killed the invocation
--      mid-pipeline BEFORE any terminal status was written — leaving them
--      'processing' with no error. imageright_reset_zombie_processing reset them
--      to 'pending' after 30 min; they were redispatched; same wall-clock kill;
--      repeat — 12+ times. Worse, those zombies occupied the entire manual
--      concurrency cap (3), so the remaining pending chunk could never start, and
--      claim-level synthesis (which requires zero pending/processing docs) could
--      never fire. The claim was permanently stuck.
--
--      FIX: cap zombie resets. After a doc has already been reset twice (this
--      would be the 3rd), mark it 'failed' (terminal) instead of cycling forever.
--      That frees the held concurrency slot and lets synthesis proceed. The reset
--      count is read from the append-only 'watchdog_reset' markers already in
--      processing_error — no schema change.
--
--   2. THROUGHPUT. The manual concurrency cap was 3, chosen when manual uploads
--      were 200-280 MB whole files that OOM-killed workers. Since PR #100 the
--      browser pre-splits every upload to <=25 MB chunks, so the OOM rationale is
--      gone and 3 is needlessly slow for an 80+ chunk claim. Raise to 6.
--
-- The ImageRight redispatch branch (small, server-streamed docs) is unchanged.

-- 1) Zombie reset, now with a give-up cap so a doc that keeps dying can't loop
--    forever (and can't permanently hold a concurrency slot / block synthesis).
CREATE OR REPLACE FUNCTION public.imageright_reset_zombie_processing()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_max_resets constant int := 2;  -- after this many prior resets, give up
BEGIN
  UPDATE claim_documents
  SET
    -- Count existing 'watchdog_reset' markers in processing_error (read from the
    -- OLD row value, before the append below). >= v_max_resets => give up.
    processing_status = CASE
      WHEN (length(COALESCE(processing_error, '')) -
            length(replace(COALESCE(processing_error, ''), 'watchdog_reset', '')))
           / length('watchdog_reset') >= v_max_resets
        THEN 'failed'
      ELSE 'pending'
    END,
    processing_started_at = NULL,
    processing_error = COALESCE(processing_error, '') ||
      CASE WHEN COALESCE(processing_error, '') = '' THEN '' ELSE ' | ' END ||
      CASE
        WHEN (length(COALESCE(processing_error, '')) -
              length(replace(COALESCE(processing_error, ''), 'watchdog_reset', '')))
             / length('watchdog_reset') >= v_max_resets
          THEN 'watchdog_gave_up: still not completing after repeated resets — marked failed so synthesis can proceed'
        ELSE 'watchdog_reset: was processing for >30min without completion'
      END
  WHERE source IN ('imageright', 'manual')
    AND processing_status = 'processing'
    AND processing_started_at IS NOT NULL
    AND processing_started_at < now() - interval '30 minutes';
END;
$function$;

-- 2) Redispatch pending docs. Manual concurrency cap raised 3 -> 6 (workers only
--    ever see <=25 MB pre-split chunks now, so the old OOM-stampede risk is gone).
CREATE OR REPLACE FUNCTION public.imageright_redispatch_stuck_pending()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_url        text := public.imageright_setting('analyze_document_url');
  v_key        text := public.imageright_setting('service_role_key');
  v_manual_cap int  := 6;     -- max manual analyze jobs in flight at once (was 3)
  v_inflight   int;
  v_slots      int;
  r            record;
BEGIN
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN;
  END IF;

  -- ImageRight docs are small and streamed server-side — keep the original
  -- behaviour (up to 5 stale-pending docs per run, oldest first).
  FOR r IN
    SELECT id
    FROM claim_documents
    WHERE source = 'imageright'
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

  -- Manual uploads: top the in-flight count up to the cap, smallest-first
  -- (quicker visible progress; big files deferred). The cap — not a long
  -- staleness delay — is what prevents the stampede, so we use a short staleness
  -- and let docs start promptly. analyze-claim-document also chains the next
  -- sibling on completion, so this watchdog is mostly the backstop now.
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

-- 3) Tighten the watchdog cadence 5 min -> 2 min so the backstop reacts faster
--    (cheap; the functions are idempotent no-ops when there's nothing to do).
--    Guarded so a missing pg_cron on any env can't fail the migration.
DO $cron$
BEGIN
  PERFORM cron.schedule(
    'imageright-watchdog-zombie-processing',
    '*/2 * * * *',
    'SELECT public.imageright_reset_zombie_processing()'
  );
  PERFORM cron.schedule(
    'imageright-watchdog-stuck-pending',
    '*/2 * * * *',
    'SELECT public.imageright_redispatch_stuck_pending()'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cron reschedule skipped: %', SQLERRM;
END;
$cron$;
