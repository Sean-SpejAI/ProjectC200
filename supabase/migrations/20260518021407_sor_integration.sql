-- Sor integration — schema, sync state, and daily-diff scheduler.
--
-- Adds: claim/document IR provenance columns, claim-level synthesis state,
-- sync_runs/sync_tasks bookkeeping, a new 'pending_content' processing
-- status (used while we wait on `View Image` permission for the spejai
-- service account), and a pg_cron daily-diff trigger guarded so the
-- migration applies cleanly even where pg_cron is not enabled.

-- =========================================================================
-- 1. claims: source + IR keys + claim-level synthesis state
-- =========================================================================

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS sor_file_id BIGINT,
  ADD COLUMN IF NOT EXISTS sor_last_modified TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sor_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS synthesis_status TEXT NOT NULL DEFAULT 'not_run',
  ADD COLUMN IF NOT EXISTS ai_synthesis JSONB,
  ADD COLUMN IF NOT EXISTS synthesized_at TIMESTAMPTZ;

ALTER TABLE public.claims
  DROP CONSTRAINT IF EXISTS claims_source_check;
ALTER TABLE public.claims
  ADD CONSTRAINT claims_source_check
  CHECK (source IN ('manual', 'sor'));

ALTER TABLE public.claims
  DROP CONSTRAINT IF EXISTS claims_synthesis_status_check;
ALTER TABLE public.claims
  ADD CONSTRAINT claims_synthesis_status_check
  CHECK (synthesis_status IN ('not_run', 'pending', 'running', 'completed', 'failed', 'skipped'));

CREATE UNIQUE INDEX IF NOT EXISTS claims_sor_file_id_key
  ON public.claims (sor_file_id) WHERE sor_file_id IS NOT NULL;

-- =========================================================================
-- 2. claim_documents: source + IR keys + pending_content state
-- =========================================================================

ALTER TABLE public.claim_documents
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS sor_document_id BIGINT,
  ADD COLUMN IF NOT EXISTS sor_page_ids BIGINT[],
  ADD COLUMN IF NOT EXISTS sor_last_modified TIMESTAMPTZ;

ALTER TABLE public.claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_source_check;
ALTER TABLE public.claim_documents
  ADD CONSTRAINT claim_documents_source_check
  CHECK (source IN ('manual', 'sor'));

-- Permit Sor rows that exist before their binary content lands.
-- file_url + file_name were declared NOT NULL on the original table; relax
-- them so pending_content rows are valid (real values land when the daily
-- diff successfully fetches the page content).
ALTER TABLE public.claim_documents ALTER COLUMN file_url DROP NOT NULL;
ALTER TABLE public.claim_documents ALTER COLUMN file_name DROP NOT NULL;

-- Extend the processing_status enum to include pending_content. Re-create
-- with the full list so we don't drop and lose the existing constraint state.
ALTER TABLE public.claim_documents
  DROP CONSTRAINT IF EXISTS claim_documents_processing_status_check;
ALTER TABLE public.claim_documents
  ADD CONSTRAINT claim_documents_processing_status_check
  CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed', 'needs_review', 'pending_content'));

CREATE UNIQUE INDEX IF NOT EXISTS claim_documents_sor_document_id_key
  ON public.claim_documents (sor_document_id) WHERE sor_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claim_documents_pending_content
  ON public.claim_documents (processing_status, uploaded_at)
  WHERE processing_status = 'pending_content';

-- =========================================================================
-- 3. sor_sync_runs — audit log per sync invocation
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.sor_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type TEXT NOT NULL,
  triggered_by UUID REFERENCES auth.users(id),
  window_from TIMESTAMPTZ,
  window_to TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  cursor JSONB,
  claims_found INTEGER NOT NULL DEFAULT 0,
  claims_synced INTEGER NOT NULL DEFAULT 0,
  documents_created INTEGER NOT NULL DEFAULT 0,
  documents_pending_content INTEGER NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  CONSTRAINT sor_sync_runs_run_type_check
    CHECK (run_type IN ('one_time', 'daily_diff', 'manual_reload')),
  CONSTRAINT sor_sync_runs_status_check
    CHECK (status IN ('running', 'completed', 'failed', 'partial'))
);

CREATE INDEX IF NOT EXISTS idx_sor_sync_runs_started
  ON public.sor_sync_runs (started_at DESC);

ALTER TABLE public.sor_sync_runs ENABLE ROW LEVEL SECURITY;

-- Admins only. Edge functions use the service role and bypass RLS.
DROP POLICY IF EXISTS "Admins can view sync runs" ON public.sor_sync_runs;
CREATE POLICY "Admins can view sync runs" ON public.sor_sync_runs
  FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));

-- =========================================================================
-- 4. sor_sync_tasks — per-claim work queue, supports chunk + resume
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.sor_sync_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.sor_sync_runs(id) ON DELETE CASCADE,
  sor_file_id BIGINT NOT NULL,
  claim_id UUID REFERENCES public.claims(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sor_sync_tasks_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'content_pending'))
);

CREATE INDEX IF NOT EXISTS idx_sor_sync_tasks_run_status
  ON public.sor_sync_tasks (run_id, status);
CREATE INDEX IF NOT EXISTS idx_sor_sync_tasks_file
  ON public.sor_sync_tasks (sor_file_id);

DROP TRIGGER IF EXISTS update_sor_sync_tasks_updated_at ON public.sor_sync_tasks;
CREATE TRIGGER update_sor_sync_tasks_updated_at
  BEFORE UPDATE ON public.sor_sync_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.sor_sync_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view sync tasks" ON public.sor_sync_tasks;
CREATE POLICY "Admins can view sync tasks" ON public.sor_sync_tasks
  FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));

-- =========================================================================
-- 5. Daily diff scheduling via pg_cron (guarded — no-op where unavailable)
-- =========================================================================
--
-- The cron schedule reads two GUC settings that the deploy script sets
-- per-env via the Management API:
--     ALTER DATABASE postgres SET app.settings.sor_sync_url = '...';
--     ALTER DATABASE postgres SET app.settings.service_role_key   = '...';
-- If either is unset, current_setting(..., true) returns NULL and the
-- net.http_post short-circuits — the job silently no-ops until configured.
-- This keeps the migration safe to apply before secrets are wired up.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN

    -- Drop any prior schedule with the same name so re-running the migration
    -- on a clean env is idempotent.
    PERFORM cron.unschedule(jobid)
      FROM cron.job WHERE jobname = 'sor-daily-diff';

    PERFORM cron.schedule(
      'sor-daily-diff',
      '0 8 * * *',  -- 03:00 Central daylight / 02:00 Central standard. Cron in UTC.
      $cron$
        SELECT
          CASE
            WHEN current_setting('app.settings.sor_sync_url', true) IS NULL
              OR current_setting('app.settings.service_role_key', true) IS NULL
            THEN NULL
            ELSE net.http_post(
              url := current_setting('app.settings.sor_sync_url'),
              headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
              ),
              body := jsonb_build_object('run_type', 'daily_diff')
            )::text
          END;
      $cron$
    );
  END IF;
END $$;
