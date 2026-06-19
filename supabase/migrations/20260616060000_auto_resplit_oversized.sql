-- Auto-resplit oversized chunks so no document can permanently fail.
--
-- A single extract pass (classify + Pass 1) on a very large/dense scanned PDF
-- can exceed the 400 s Edge worker wall-clock and be killed. New uploads are
-- already capped at ≤12 MB / ≤15 pages by the browser splitter, but legacy
-- claims (and any pathological future chunk) can still arrive too big. The
-- analyze-claim-document 'resplit' stage splits such a doc into ≤12 MB /
-- ≤15-page pieces and pushes each through the staged pipeline; the parent is
-- marked 'superseded'.
--
-- This migration adds the 'superseded' status and teaches the pump's
-- dead-letter branch to ROUTE a doc that exhausted its extract attempts to the
-- 'resplit' stage (reactive net) instead of marking it 'failed'. The proactive
-- net (>18 MB split before the first extract attempt) lives in the Edge fn.

-- 1) New terminal status for a parent that was split into smaller children.
alter table public.claim_documents
  drop constraint if exists claim_documents_processing_status_check;
alter table public.claim_documents
  add constraint claim_documents_processing_status_check
  check (processing_status = any (array[
    'pending','processing','completed','failed','needs_review','pending_content','superseded'
  ]));

-- 2) Pump: on dead-letter, auto-resplit instead of failing when the doc is
--    plausibly too big (size-splittable) and not too deeply nested. A doc that
--    keeps failing for a non-size reason (or a 'resplit' stage that itself
--    keeps failing) still falls through to 'failed' — no infinite loop.
create or replace function public.analyze_stages_pump()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_enabled text := public.sor_setting('staged_analysis_enabled');
  v_url     text := public.sor_setting('analyze_document_url');
  v_key     text := public.sor_setting('service_role_key');
  v_vt      int  := 600;  -- visibility timeout (s) > 400 s worker wall-clock
  v_batch   int  := 6;    -- max stage-dispatches per tick (in-flight cap)
  v_maxread int  := 4;    -- reads before dead-letter (a stage that keeps dying)
  r         record;
begin
  if v_enabled is distinct from 'true' or v_url is null or v_key is null then
    return;  -- inert until explicitly enabled
  end if;

  for r in select * from pgmq.read('analyze_stages', v_vt, v_batch) loop
    if r.read_ct > v_maxread then
      perform pgmq.archive('analyze_stages', r.msg_id);
      declare
        v_size  bigint;
        v_depth int;
        v_stage text := coalesce(r.message->>'stage', '?');
        v_docid uuid := (r.message->>'documentId')::uuid;
      begin
        select file_size, coalesce((claim_details->>'resplit_depth')::int, 0)
          into v_size, v_depth
          from claim_documents where id = v_docid;
        if v_stage in ('extract', 'classify')
           and coalesce(v_size, 0) > 12 * 1024 * 1024
           and coalesce(v_depth, 0) < 3 then
          -- Too big to extract in one pass → route to resplit rather than fail.
          perform public.analyze_stages_enqueue(v_docid, 'resplit');
        else
          update claim_documents
             set processing_status = 'failed',
                 processing_error = coalesce(processing_error, '') ||
                   case when coalesce(processing_error, '') = '' then '' else ' | ' end ||
                   'staged_pump_gave_up: stage ' || v_stage || ' exceeded ' || v_maxread || ' attempts'
           where id = v_docid;
        end if;
      end;
      continue;
    end if;
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object(
        'documentId', r.message->>'documentId',
        'stage',      r.message->>'stage',
        'msgId',      r.msg_id,
        'async',      true
      )
    );
  end loop;
end;
$fn$;
