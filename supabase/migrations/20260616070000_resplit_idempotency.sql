-- Resplit idempotency hardening (adversarial-review follow-up to 20260616060000).
--
-- Two concurrency defects in the auto-resplit path:
--   1) A concurrent/redelivered resplit could pass the JS check-then-insert
--      idempotency guard and create DUPLICATE children (same pages twice).
--   2) A mid-loop enqueue failure left some children un-queued; redelivery's
--      early-return never re-armed them, hanging the claim's synthesis.
--
-- Fixes:
--   1) A UNIQUE partial index on (resplit_of, resplit_part) so a duplicate
--      resplit collides at the DB (23505) instead of double-inserting; the Edge
--      fn catches that and reconciles.
--   2) analyze_stages_enqueue_if_idle(): atomically flips a doc's
--      analysis_stage NULL->extract and enqueues EXACTLY ONCE (NULL if it was
--      already armed). The Edge fn's reconcile loop calls this per child, so a
--      redelivery re-arms only the children a prior partial run left un-queued
--      and never double-queues one already in flight.

-- 1) No two resplit children may share (parent, part). Partial: only rows that
--    carry a resplit_of marker participate, so normal docs are unaffected.
create unique index if not exists claim_documents_resplit_part_uq
  on public.claim_documents (
    ((claim_details->>'resplit_of')),
    ((claim_details->>'resplit_part'))
  )
  where (claim_details ? 'resplit_of');

-- 2) Idempotent, atomic enqueue. Returns the new pgmq msg id, or NULL if the
--    doc was already armed (another caller won the NULL->extract transition).
create or replace function public.analyze_stages_enqueue_if_idle(p_document_id uuid)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_msg bigint;
  v_upd int;
begin
  update claim_documents
     set analysis_stage = 'extract'
   where id = p_document_id
     and analysis_stage is null;
  get diagnostics v_upd = row_count;
  if v_upd = 0 then
    return null;  -- already armed (or gone) — do NOT enqueue a duplicate
  end if;
  select pgmq.send('analyze_stages',
           jsonb_build_object('documentId', p_document_id::text, 'stage', 'extract'))
    into v_msg;
  return v_msg;
end;
$fn$;
