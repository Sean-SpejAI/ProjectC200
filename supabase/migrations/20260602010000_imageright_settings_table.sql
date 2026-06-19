-- ImageRight cron settings table — replaces the app.settings.* GUC approach
-- because Supabase blocks `ALTER DATABASE postgres SET app.settings.*` from
-- the postgres role used by the Management API CLI. With this in place the
-- whole config can be managed via a normal INSERT/UPDATE from the CLI.
--
-- Affects:
--   - The 3 watchdog functions added in 20260602000000 (rescue_stuck_runs,
--     reset_zombie_processing, redispatch_stuck_pending) — re-created here
--     to read from this table instead of current_setting().
--   - The pre-existing imageright-daily-diff pg_cron schedule (added in
--     20260518021407) — re-scheduled here for the same reason. That cron
--     has been a no-op on prod since it landed (pg_cron + GUCs both missing).
--
-- Caller responsibility: after this migration applies, INSERT the three rows
-- via the CLI or supabase dashboard. See `scripts/setup_imageright_settings.sql`.

-- =========================================================================
-- 1. Settings table — single source of truth for cron config
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.imageright_settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.imageright_settings IS
  'Cron + watchdog runtime config (URLs, service-role key). Read by the imageright_rescue_stuck_runs / imageright_redispatch_stuck_pending pg_cron jobs and by the imageright-daily-diff schedule.';

ALTER TABLE public.imageright_settings ENABLE ROW LEVEL SECURITY;

-- Deny-all RLS — only service role (which bypasses RLS) reads/writes. The
-- `service_role_key` row contains a secret JWT; we don't want it visible to
-- the `authenticated` role even though admins-only would otherwise apply.
DROP POLICY IF EXISTS "deny all on imageright_settings" ON public.imageright_settings;
CREATE POLICY "deny all on imageright_settings" ON public.imageright_settings
  FOR ALL TO authenticated, anon USING (false) WITH CHECK (false);

-- Helper: small inline lookup so the cron functions don't need verbose joins.
CREATE OR REPLACE FUNCTION public.imageright_setting(p_name TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT value FROM public.imageright_settings WHERE name = p_name;
$$;

REVOKE ALL ON FUNCTION public.imageright_setting(TEXT) FROM PUBLIC, anon, authenticated;

-- =========================================================================
-- 2. Re-create the 3 watchdog functions to read from imageright_settings
-- =========================================================================

CREATE OR REPLACE FUNCTION public.imageright_rescue_stuck_runs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url     text := public.imageright_setting('imageright_sync_url');
  v_key     text := public.imageright_setting('service_role_key');
  v_stale   interval := interval '5 minutes';
  v_max_kicks int := 5;
  r         record;
  v_kicks   int;
BEGIN
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN;  -- settings not populated; no-op
  END IF;

  FOR r IN
    SELECT
      run.id,
      run.cursor,
      GREATEST(
        run.started_at,
        COALESCE((SELECT max(t.updated_at) FROM imageright_sync_tasks t WHERE t.run_id = run.id), run.started_at)
      ) AS last_activity
    FROM imageright_sync_runs run
    WHERE run.status = 'running'
      AND run.started_at < now() - v_stale
      AND NOT EXISTS (
        SELECT 1 FROM imageright_sync_tasks t
        WHERE t.run_id = run.id
          AND t.updated_at >= now() - v_stale
      )
  LOOP
    v_kicks := COALESCE((r.cursor->>'watchdog_kicks')::int, 0);

    IF v_kicks >= v_max_kicks THEN
      UPDATE imageright_sync_runs
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

    UPDATE imageright_sync_runs
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

REVOKE ALL ON FUNCTION public.imageright_rescue_stuck_runs() FROM PUBLIC, anon, authenticated;

-- (zombie reset doesn't need any settings — keep its body identical to v1)

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

-- =========================================================================
-- 3. Re-schedule the pre-existing daily-diff cron to read from the table
-- =========================================================================
--
-- Original lives in 20260518021407_imageright_integration.sql. Same DO-block
-- guard pattern. The cron.schedule call's SQL body is the only thing that
-- changes here.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN

    PERFORM cron.unschedule(jobid)
      FROM cron.job WHERE jobname = 'imageright-daily-diff';

    PERFORM cron.schedule(
      'imageright-daily-diff',
      '0 8 * * *',  -- 03:00 Central daylight / 02:00 Central standard
      $cron$
        SELECT
          CASE
            WHEN public.imageright_setting('imageright_sync_url') IS NULL
              OR public.imageright_setting('service_role_key') IS NULL
            THEN NULL
            ELSE net.http_post(
              url := public.imageright_setting('imageright_sync_url'),
              headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || public.imageright_setting('service_role_key')
              ),
              body := jsonb_build_object('run_type', 'daily_diff')
            )::text
          END;
      $cron$
    );

    -- Re-schedule the watchdogs too (idempotent — same names + bodies as
    -- 20260602000000, but easier to keep all the cron registration in one
    -- DO block so re-applying this migration is a single point of truth).
    PERFORM cron.unschedule(jobid)
      FROM cron.job WHERE jobname IN (
        'imageright-watchdog-stuck-runs',
        'imageright-watchdog-zombie-processing',
        'imageright-watchdog-stuck-pending'
      );

    PERFORM cron.schedule(
      'imageright-watchdog-stuck-runs',
      '*/5 * * * *',
      $cron$SELECT public.imageright_rescue_stuck_runs()$cron$
    );

    PERFORM cron.schedule(
      'imageright-watchdog-zombie-processing',
      '*/5 * * * *',
      $cron$SELECT public.imageright_reset_zombie_processing()$cron$
    );

    PERFORM cron.schedule(
      'imageright-watchdog-stuck-pending',
      '*/5 * * * *',
      $cron$SELECT public.imageright_redispatch_stuck_pending()$cron$
    );
  END IF;
END $$;
