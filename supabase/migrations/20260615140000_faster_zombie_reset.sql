-- Speed up recovery of docs whose analyze worker overran the 400 s wall-clock.
--
-- The zombie-reset watchdog reset 'processing' docs after 30 min. But the Edge
-- worker is HARD-killed at 400 s (6.7 min), so a doc still 'processing' after
-- ~8 min is already dead — waiting 30 min to retry it just wastes ~23 min per
-- overrun. On a large claim where several chunks overrun (dense scanned medical
-- PDFs), this 30-min retry latency dominates wall-clock and the claim crawls.
--
-- Lower the threshold to 8 min: comfortably past the 400 s worker limit (so we
-- never reset a genuinely-live worker), but ~4× faster retries for the dead
-- ones. The give-up cap (mark 'failed' after the 3rd reset) is unchanged, so a
-- chunk that truly can't complete now fails in ~24 min instead of ~90, freeing
-- its concurrency slot and unblocking synthesis sooner.
CREATE OR REPLACE FUNCTION public.sor_reset_zombie_processing()
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
        ELSE 'watchdog_reset: was processing for >8min without completion'
      END
  WHERE source IN ('sor', 'manual')
    AND processing_status = 'processing'
    AND processing_started_at IS NOT NULL
    AND processing_started_at < now() - interval '8 minutes';
END;
$function$;
