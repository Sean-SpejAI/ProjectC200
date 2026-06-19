-- Pg-cron-driven sync continuation ping.
--
-- The legacy approach for keeping an `sor-sync` run alive across many
-- short invocations was EdgeRuntime.waitUntil(rescheduleSelf) — i.e. the
-- function fires a continuation HTTP call right before it returns. In
-- practice that chain has stalled silently mid-run more than once (see
-- feedback_curated_reload_runbook.md). The 2026-06-10 reload worked around
-- the stall with a bash loop hand-pinging continuation every 30 seconds.
--
-- This job replaces that workaround. It's the SAME shape as
-- sor_rescue_stuck_runs (pings the sync URL with {continuation,
-- run_id}) but with two key differences:
--
--   * Shorter staleness threshold: 60 seconds (vs. the rescue's 5 minutes).
--     The rescue cron handles the "run is truly broken" case; this one
--     handles "the reschedule chain skipped a beat."
--
--   * No max-kicks cap. The job is meant to fire continuously during long
--     curated reloads, so capping it would defeat the purpose. The rescue
--     cron's max-kicks (5) still applies — it'll mark a genuinely broken
--     run as failed after 25 minutes of no progress.
--
-- Default schedule: NEVER (`0 0 31 2 *` — Feb 31). Enabled manually during a
-- curated reload:
--
--   SELECT cron.alter_job(
--     (SELECT jobid FROM cron.job WHERE jobname='sor-sync-keepalive'),
--     schedule := '* * * * *');
--
-- ...then reverted to NEVER after the reload.

CREATE OR REPLACE FUNCTION public.sor_sync_keepalive()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url   text := public.sor_setting('sor_sync_url');
  v_key   text := public.sor_setting('service_role_key');
  v_stale interval := interval '60 seconds';
  r       record;
BEGIN
  IF v_url IS NULL OR v_key IS NULL THEN
    RETURN;  -- settings not populated; no-op
  END IF;

  FOR r IN
    SELECT run.id
    FROM sor_sync_runs run
    WHERE run.status = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM sor_sync_tasks t
        WHERE t.run_id = run.id
          AND t.updated_at >= now() - v_stale
      )
  LOOP
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

REVOKE ALL ON FUNCTION public.sor_sync_keepalive() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN

    PERFORM cron.unschedule(jobid)
      FROM cron.job WHERE jobname = 'sor-sync-keepalive';

    PERFORM cron.schedule(
      'sor-sync-keepalive',
      '0 0 31 2 *',  -- Feb 31 = never. Enable manually during a curated reload.
      $cron$SELECT public.sor_sync_keepalive()$cron$
    );
  END IF;
END $$;
