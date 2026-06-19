-- Phase 2 FOUNDATION: staged, one-pass-per-invocation analysis via pgmq + pg_cron.
--
-- WHY: the per-document pipeline runs Pass 0 (classify, full PDF) + Pass 1
-- (extract, full PDF) + gap-fill/validate/self-heal + Pass 5 (Anthropic
-- grounding) in ONE Edge worker. The 400 s wall-clock is a hard cap (background
-- tasks share it), so big scanned docs are killed mid-pipeline. Splitting the
-- work into chained STAGES — each ≤ one heavy pass, persisted before hand-off —
-- means no single invocation approaches 400 s.
--
-- This migration is the INERT FOUNDATION. Nothing changes until BOTH:
--   (a) imageright_settings.staged_analysis_enabled = 'true', AND
--   (b) analyze-claim-document ships its {stage} handler.
-- Default OFF → the existing monolithic path stays the default and can't break.
--
-- Stages: classify -> extract -> enrich -> ground -> done. analyze-claim-document
-- runs ONE stage, persists, enqueues the next (pgmq.send) and deletes the current
-- message (pgmq.delete). The pump below dispatches queued stages and dead-letters
-- messages that exceed the read cap.

create extension if not exists pgmq;

-- Queues: main work + dead-letter (idempotent — pgmq.create is a no-op if exists).
do $q$
begin
  perform pgmq.create('analyze_stages');
exception when others then raise notice 'pgmq.create analyze_stages: %', sqlerrm; end;
$q$;
do $q$
begin
  perform pgmq.create('analyze_stages_dead');
exception when others then raise notice 'pgmq.create analyze_stages_dead: %', sqlerrm; end;
$q$;

-- Durable per-doc stage marker (survives queue hiccups; lets a watchdog re-enqueue
-- from the right point). NULL = not in the staged pipeline.
alter table public.claim_documents
  add column if not exists analysis_stage text;

-- Enqueue helper — starts (or advances) a document's stage chain. Also stamps
-- claim_documents.analysis_stage = the enqueued stage so it is the doc's "due
-- stage": the handler processes a message ONLY when its stage matches this
-- column, which makes redelivered/stale messages no-ops (idempotency).
create or replace function public.analyze_stages_enqueue(p_document_id uuid, p_stage text default 'extract')
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_msg bigint;
begin
  update claim_documents set analysis_stage = p_stage where id = p_document_id;
  select pgmq.send('analyze_stages', jsonb_build_object('documentId', p_document_id::text, 'stage', p_stage)) into v_msg;
  return v_msg;
end;
$fn$;

-- Public SECURITY DEFINER wrapper so the Edge function can delete a processed
-- message via PostgREST rpc (the pgmq / pgmq_public schemas are NOT exposed to
-- PostgREST on a bare `create extension pgmq`, so calling them directly fails).
create or replace function public.analyze_stages_delete(p_msg_id bigint)
 returns boolean
 language sql
 security definer
 set search_path to 'public'
as $fn$
  select pgmq.delete('analyze_stages', p_msg_id);
$fn$;

-- Pump: cron-driven dispatcher. Reads a bounded batch (with a visibility timeout
-- longer than the 400 s worker limit so a killed stage's message redelivers only
-- after the worker is surely dead), dispatches each to analyze-claim-document
-- (async, fire-and-forget) with its stage + msg_id (the stage deletes the message
-- on success), and dead-letters messages read too many times.
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
      update claim_documents
         set processing_status = 'failed',
             processing_error = coalesce(processing_error, '') ||
               case when coalesce(processing_error,'') = '' then '' else ' | ' end ||
               'staged_pump_gave_up: stage ' || coalesce(r.message->>'stage','?') ||
               ' exceeded ' || v_maxread || ' attempts'
       where id = (r.message->>'documentId')::uuid;
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

-- Cron: pump every minute. Idempotent; guarded so a missing pg_cron can't fail
-- the migration. Inert until the flag is on (the pump early-returns otherwise).
do $cron$
begin
  perform cron.schedule('analyze-stages-pump', '* * * * *', 'select public.analyze_stages_pump()');
exception when others then
  raise notice 'analyze-stages-pump schedule skipped: %', sqlerrm;
end;
$cron$;

-- ---------------------------------------------------------------------------
-- Watchdog isolation: the MONOLITHIC watchdogs must NOT touch docs that are in
-- the staged pipeline (analysis_stage IS NOT NULL) — otherwise a staged doc
-- left 'processing'/'pending' between stages would be reset / re-dispatched
-- into the monolithic analyze path, running two pipelines on one doc. Both
-- functions below are the current definitions + an `analysis_stage IS NULL`
-- filter. (Staged retries are handled by the pgmq pump's redelivery, not these.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.imageright_reset_zombie_processing()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_max_resets constant int := 2;
BEGIN
  UPDATE claim_documents
  SET
    processing_status = CASE
      WHEN (length(COALESCE(processing_error, '')) -
            length(replace(COALESCE(processing_error, ''), 'watchdog_reset', '')))
           / length('watchdog_reset') >= v_max_resets
        THEN 'failed' ELSE 'pending' END,
    processing_started_at = NULL,
    processing_error = COALESCE(processing_error, '') ||
      CASE WHEN COALESCE(processing_error, '') = '' THEN '' ELSE ' | ' END ||
      CASE
        WHEN (length(COALESCE(processing_error, '')) -
              length(replace(COALESCE(processing_error, ''), 'watchdog_reset', '')))
             / length('watchdog_reset') >= v_max_resets
          THEN 'watchdog_gave_up: still not completing after repeated resets — marked failed so synthesis can proceed'
        ELSE 'watchdog_reset: was processing for >8min without completion' END
  WHERE source IN ('imageright', 'manual')
    AND processing_status = 'processing'
    AND analysis_stage IS NULL                  -- skip staged docs (pump owns them)
    AND processing_started_at IS NOT NULL
    AND processing_started_at < now() - interval '8 minutes';
END;
$function$;

CREATE OR REPLACE FUNCTION public.imageright_redispatch_stuck_pending()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_url        text := public.imageright_setting('analyze_document_url');
  v_key        text := public.imageright_setting('service_role_key');
  v_manual_cap int  := 6;
  v_inflight   int;
  v_slots      int;
  r            record;
BEGIN
  IF v_url IS NULL OR v_key IS NULL THEN RETURN; END IF;

  FOR r IN
    SELECT id FROM claim_documents
    WHERE source = 'imageright' AND processing_status = 'pending'
      AND analysis_stage IS NULL                -- skip staged docs
      AND uploaded_at < now() - interval '10 minutes'
    ORDER BY uploaded_at ASC LIMIT 5
  LOOP
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object('documentId', r.id, 'async', true));
  END LOOP;

  SELECT count(*) INTO v_inflight
  FROM claim_documents
  WHERE source = 'manual' AND processing_status = 'processing'
    AND analysis_stage IS NULL;                 -- only monolithic in-flight counts

  v_slots := v_manual_cap - v_inflight;
  IF v_slots > 0 THEN
    FOR r IN
      SELECT id FROM claim_documents
      WHERE source = 'manual' AND processing_status = 'pending'
        AND analysis_stage IS NULL              -- skip staged docs
        AND uploaded_at < now() - interval '90 seconds'
      ORDER BY file_size ASC NULLS FIRST, uploaded_at ASC
      LIMIT v_slots
    LOOP
      PERFORM net.http_post(
        url := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
        body := jsonb_build_object('documentId', r.id, 'async', true));
    END LOOP;
  END IF;
END;
$function$;
