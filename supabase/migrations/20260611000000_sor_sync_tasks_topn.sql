-- sor_sync_tasks: top-N-by-doc-count selection mode
--
-- Adds the doc-count column that drives top-N sort, and extends the status
-- check to allow the two-pass states the new selection_mode='top_n_by_docs'
-- introduces:
--   - 'metadata_counted' — pass 1 wrote total_docs, awaiting top-N selection
--   - 'skipped'          — fell outside the top-N (or the older min_docs gate
--                          in PR #88 which was being silently rejected by
--                          the old constraint and never landing — see the
--                          existing sor-sync code).
--
-- Index on (run_id, total_docs DESC NULLS LAST) supports the one-shot
-- "ROW_NUMBER() OVER (ORDER BY total_docs DESC)" UPDATE used to mark the
-- top-N at end of pass 1.

ALTER TABLE public.sor_sync_tasks
  ADD COLUMN IF NOT EXISTS total_docs INTEGER;

ALTER TABLE public.sor_sync_tasks
  DROP CONSTRAINT IF EXISTS sor_sync_tasks_status_check;

ALTER TABLE public.sor_sync_tasks
  ADD CONSTRAINT sor_sync_tasks_status_check
  CHECK (status IN (
    'queued',
    'running',
    'succeeded',
    'failed',
    'content_pending',
    'metadata_counted',
    'skipped'
  ));

CREATE INDEX IF NOT EXISTS idx_sor_sync_tasks_run_total_docs
  ON public.sor_sync_tasks (run_id, total_docs DESC NULLS LAST);
