-- Sor watchdogs — recover from broken self-reschedule chains and
-- stuck claim_documents rows that the in-function logic can't reach.
--
-- Bugs this addresses (all observed in prod on 2026-06-01):
--
--   1. sor_sync_runs stuck in status='running' for hours when the
--      EdgeRuntime.waitUntil(rescheduleSelf) chain in sor-sync dies
--      silently. No in-function watchdog can recover this because the
--      function isn't running.
--
--   2. claim_documents rows stuck in processing_status='processing' for
--      hours when analyze-claim-document times out or OOMs without
--      updating the row.
--
--   3. claim_documents rows stuck in processing_status='pending' when the
--      fire-and-forget analyze dispatch was rate-limited (HTTP 429
--      silently lost). The doc is fetched and stored, but analyze never
--      ran on it.
--
-- All three watchdogs run via pg_cron every 5 minutes, guarded by the
-- usual pg_cron + pg_net extension check + GUC presence check so the
-- migration is safe to apply before the env is wired up.

-- =========================================================================
-- Helper SQL functions (created unconditionally — they are no-ops without
-- pg_net, and pg_cron schedules below only fire when both extensions are
-- present).
-- =========================================================================

-- Rescue runs stuck in 'running' that haven't made progress in N minutes.
-- "Progress" = a task row was updated, or the run row was updated. We use
-- a join against sor_sync_tasks to find max(updated_at); if no tasks
-- exist for the run yet (e.g. a daily_diff that found 0 claims), we fall
-- back to sor_sync_runs.started_at.
--
-- For each stale run, posts a {continuation:true, run_id:...} payload back
-- to the sor-sync function so it can pick up where it left off.
-- After 5 unsuccessful kicks (tracked via the watchdog_kicks counter in
-- the cursor), the run is marked 'failed' so we stop burning cron cycles
-- on something that's genuinely dead.
CREATE OR REPLACE FUNCTION public.sor_rescue_stuck_runs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url     text := current_setting('app.settings.sor_sync_url', true);
  v_key     text := current_setting('app.settings.service_role_key', true);
  v_stale   interval := interval '5 minutes';
  v_max_kicks int := 5;
  r         record;
  v_kicks   int;
BEGIN
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN;  -- env not wired up; no-op
  END IF;

  FOR r IN
    SELECT
      run.id,
      run.cursor,
      GREATEST(
        run.started_at,
        COALESCE((SELECT max(t.updated_at) FROM sor_sync_tasks t WHERE t.run_id = run.id), run.started_at)
      ) AS last_activity
    FROM sor_sync_runs run
    WHERE run.status = 'running'
      AND run.started_at < now() - v_stale
      AND NOT EXISTS (
        SELECT 1 FROM sor_sync_tasks t
        WHERE t.run_id = run.id
          AND t.updated_at >= now() - v_stale
      )
  LOOP
    v_kicks := COALESCE((r.cursor->>'watchdog_kicks')::int, 0);

    IF v_kicks >= v_max_kicks THEN
      -- Genuinely dead — stop kicking, mark failed so the run stops
      -- showing up in this watchdog's working set.
      UPDATE sor_sync_runs
      SET status = 'failed',
          completed_at = now(),
          errors = errors || jsonb_build_object(
            'at', now(),
            'stage', 'watchdog',
            'message', 'Marked failed after ' || v_max_kicks || ' watchdog kicks failed to revive the run',
            'retryable', false
          )
      WHERE id = r.id;
      CONTINUE;
    END IF;

    -- Increment kick counter, log the kick, then fire the continuation.
    UPDATE sor_sync_runs
    SET cursor = COALESCE(cursor, '{}'::jsonb) || jsonb_build_object('watchdog_kicks', v_kicks + 1),
        errors = errors || jsonb_build_object(
          'at', now(),
          'stage', 'watchdog',
          'message', 'Stale run kick #' || (v_kicks + 1) || ' (no activity since ' || r.last_activity || ')',
          'retryable', true
        )
    WHERE id = r.id;

    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body := jsonb_build_object('continuation', true, 'run_id', r.id)
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.sor_rescue_stuck_runs() FROM PUBLIC, anon, authenticated;

-- Reset claim_documents rows stuck in 'processing' for too long. The
-- analyze-claim-document function should update the row on success or
-- failure, but if it times out / OOMs / is killed mid-run, the row is
-- orphaned. Reset to 'pending' so the next watchdog tick re-fires analyze.
CREATE OR REPLACE FUNCTION public.sor_reset_zombie_processing()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE claim_documents
  SET processing_status = 'pending',
      processing_started_at = NULL,
      processing_error = COALESCE(processing_error, '') ||
        CASE WHEN COALESCE(processing_error, '') = '' THEN '' ELSE ' | ' END ||
        'watchdog_reset: was processing for >30min without completion'
  WHERE source = 'sor'
    AND processing_status = 'processing'
    AND processing_started_at IS NOT NULL
    AND processing_started_at < now() - interval '30 minutes';
END;
$$;

REVOKE ALL ON FUNCTION public.sor_reset_zombie_processing() FROM PUBLIC, anon, authenticated;

-- Re-fire analyze-claim-document for rows stuck in 'pending' for too long.
-- This covers the case where pull-claim or the sweep dispatched analyze
-- but the dispatch got rate-limited (HTTP 429) and the doc was silently
-- left in 'pending'. Bounded to 5 docs per tick to avoid retripping the
-- rate limit.
CREATE OR REPLACE FUNCTION public.sor_redispatch_stuck_pending()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url    text := current_setting('app.settings.analyze_document_url', true);
  v_key    text := current_setting('app.settings.service_role_key', true);
  v_stale  interval := interval '10 minutes';
  r        record;
BEGIN
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN;  -- env not wired up; no-op
  END IF;

  FOR r IN
    SELECT id
    FROM claim_documents
    WHERE source = 'sor'
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

REVOKE ALL ON FUNCTION public.sor_redispatch_stuck_pending() FROM PUBLIC, anon, authenticated;

-- =========================================================================
-- pg_cron schedules — guarded so the migration is safe where pg_cron is
-- absent (e.g. dev branch). Each schedule runs every 5 minutes.
-- =========================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN

    -- Re-schedule idempotently
    PERFORM cron.unschedule(jobid)
      FROM cron.job WHERE jobname IN (
        'sor-watchdog-stuck-runs',
        'sor-watchdog-zombie-processing',
        'sor-watchdog-stuck-pending'
      );

    PERFORM cron.schedule(
      'sor-watchdog-stuck-runs',
      '*/5 * * * *',
      $cron$SELECT public.sor_rescue_stuck_runs()$cron$
    );

    PERFORM cron.schedule(
      'sor-watchdog-zombie-processing',
      '*/5 * * * *',
      $cron$SELECT public.sor_reset_zombie_processing()$cron$
    );

    PERFORM cron.schedule(
      'sor-watchdog-stuck-pending',
      '*/5 * * * *',
      $cron$SELECT public.sor_redispatch_stuck_pending()$cron$
    );
  END IF;
END $$;
