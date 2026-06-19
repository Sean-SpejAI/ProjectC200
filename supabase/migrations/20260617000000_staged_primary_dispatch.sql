-- Make the staged pgmq pipeline the PRIMARY analysis dispatcher (flag-gated).
--
-- The Edge routing (imageright-pull-claim, imageright-sync sweep,
-- process-uploaded-claim) now calls analyze_stages_enqueue_if_idle when
-- staged_analysis_enabled='true'. This migration completes the DB side:
--   1) pump batch size is tunable live via the `pump_batch` setting (default 8)
--      so a big nightly ImageRight sync can be sped up without a redeploy;
--   2) the stuck-pending watchdog promotes not-yet-staged 'pending' docs INTO
--      the staged pipeline (instead of the monolith) when the flag is on — the
--      safety net for any doc whose immediate enqueue was missed;
--   3) a new backstop re-arms staged docs orphaned with NO live pgmq message
--      (e.g. a dead-lettered-then-stuck doc), which the monolith watchdogs skip.
--
-- Rollback = set staged_analysis_enabled='false' (pump + backstop go inert
-- within a tick; the watchdog reverts to monolith dispatch) and clear
-- analysis_stage on any stranded docs so the monolith watchdogs re-adopt them.

-- 1) Pump with a live-tunable batch size (clamped to a safe ceiling). Body is
--    otherwise identical to 20260616060000 (resplit dead-letter branch intact).
create or replace function public.analyze_stages_pump()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_enabled text := public.imageright_setting('staged_analysis_enabled');
  v_url     text := public.imageright_setting('analyze_document_url');
  v_key     text := public.imageright_setting('service_role_key');
  v_vt      int  := 600;  -- visibility timeout (s) > 400 s worker wall-clock
  v_batch   int  := coalesce(nullif(public.imageright_setting('pump_batch'), '')::int, 8);
  v_maxread int  := 4;    -- reads before dead-letter (a stage that keeps dying)
  r         record;
begin
  if v_enabled is distinct from 'true' or v_url is null or v_key is null then
    return;  -- inert until explicitly enabled
  end if;
  if v_batch < 1  then v_batch := 1;  end if;
  if v_batch > 25 then v_batch := 25; end if;  -- hard safety clamp

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

-- 2) Watchdog: when staged, promote not-yet-staged 'pending' docs into the
--    pump (enqueue_if_idle) instead of dispatching the monolith. Keeps the
--    analysis_stage IS NULL filter so staged docs stay owned by the pump.
create or replace function public.imageright_redispatch_stuck_pending()
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_staged     boolean := public.imageright_setting('staged_analysis_enabled') is not distinct from 'true';
  v_url        text := public.imageright_setting('analyze_document_url');
  v_key        text := public.imageright_setting('service_role_key');
  v_manual_cap int  := 6;
  v_inflight   int;
  v_slots      int;
  r            record;
begin
  -- Monolith dispatch needs url+key; the staged path uses the enqueue RPC.
  if not v_staged and (v_url is null or v_key is null) then return; end if;

  -- ImageRight: stale-pending docs not yet in the staged pipeline.
  for r in
    select id from claim_documents
    where source = 'imageright' and processing_status = 'pending'
      and analysis_stage is null
      and uploaded_at < now() - interval '10 minutes'
    order by uploaded_at asc limit 5
  loop
    if v_staged then
      perform public.analyze_stages_enqueue_if_idle(r.id);
    else
      perform net.http_post(url := v_url,
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key),
        body := jsonb_build_object('documentId', r.id, 'async', true));
    end if;
  end loop;

  -- Manual: staged enqueues ALL idle pending (the pump's batch is the cap);
  -- monolith tops the in-flight count up to v_manual_cap.
  if v_staged then
    for r in
      select id from claim_documents
      where source = 'manual' and processing_status = 'pending'
        and analysis_stage is null
        and uploaded_at < now() - interval '90 seconds'
      order by file_size asc nulls first, uploaded_at asc
    loop
      perform public.analyze_stages_enqueue_if_idle(r.id);
    end loop;
  else
    select count(*) into v_inflight
    from claim_documents
    where source = 'manual' and processing_status = 'processing' and analysis_stage is null;
    v_slots := v_manual_cap - v_inflight;
    if v_slots > 0 then
      for r in
        select id from claim_documents
        where source = 'manual' and processing_status = 'pending'
          and analysis_stage is null
          and uploaded_at < now() - interval '90 seconds'
        order by file_size asc nulls first, uploaded_at asc
        limit v_slots
      loop
        perform net.http_post(url := v_url,
          headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key),
          body := jsonb_build_object('documentId', r.id, 'async', true));
      end loop;
    end if;
  end if;
end;
$function$;

-- 3) Backstop: re-arm staged docs that are non-terminal but have NO live pgmq
--    message (orphaned by a lost/dead-lettered message). The monolith watchdogs
--    skip analysis_stage IS NOT NULL, so without this such a doc strands forever.
--    Race-free: only docs with zero live messages (invisible/in-flight messages
--    still count as live) and a 15-min grace, so we never duplicate a stage that
--    pgmq will redeliver on its own. Re-running a stage is idempotent.
create or replace function public.analyze_stages_backstop()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_enabled text := public.imageright_setting('staged_analysis_enabled');
  r         record;
begin
  if v_enabled is distinct from 'true' then return; end if;  -- inert pre-cutover / on rollback
  for r in
    select d.id, d.analysis_stage
    from claim_documents d
    where d.analysis_stage in ('extract', 'enrich', 'ground', 'resplit')
      and d.processing_status not in ('completed', 'failed', 'needs_review', 'superseded')
      and coalesce(d.processing_started_at, d.uploaded_at) < now() - interval '15 minutes'
      and not exists (
        select 1 from pgmq.q_analyze_stages q
        where (q.message->>'documentId')::uuid = d.id
      )
    limit 20
  loop
    perform pgmq.send('analyze_stages',
      jsonb_build_object('documentId', r.id::text, 'stage', r.analysis_stage));
  end loop;
end;
$fn$;

do $cron$
begin
  perform cron.schedule('analyze-stages-backstop', '*/5 * * * *', 'select public.analyze_stages_backstop()');
exception when others then
  raise notice 'analyze-stages-backstop schedule skipped: %', sqlerrm;
end;
$cron$;
