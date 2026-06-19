-- =====================================================================
-- One-time per-env setup for ImageRight cron jobs (daily-diff + watchdogs)
-- =====================================================================
--
-- Populates the public.imageright_settings table (created by migration
-- 20260602010000) with the URLs + service-role key the cron jobs need.
-- Safe to run multiple times (UPSERTs).
--
-- Per-env values to fill in:
--   - PROJECT_REF: the Supabase project ref
--       prod:  oopjlechxxbyisntbtvw
--       stage: oaqoailpmfzjzwrkklzu
--       dev:   evpmuoxfrnmustokkaqg
--   - SERVICE_ROLE_KEY: the env's service-role JWT (NOT the sb_secret_*
--       short form). Find it at:
--         Supabase dashboard -> Project Settings -> API -> "service_role"
--
-- Once a row is present, the corresponding cron job stops being a no-op
-- on its next firing (≤ 5 min for watchdogs, next 08:00 UTC for daily-diff).

INSERT INTO public.imageright_settings (name, value, updated_at)
VALUES
  ('imageright_sync_url',    'https://<PROJECT_REF>.supabase.co/functions/v1/imageright-sync',          now()),
  ('analyze_document_url',   'https://<PROJECT_REF>.supabase.co/functions/v1/analyze-claim-document',   now()),
  ('service_role_key',       '<SERVICE_ROLE_KEY>',                                                       now())
ON CONFLICT (name) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();

-- Verify (run separately or uncomment):
--
--   SELECT name,
--          CASE WHEN name = 'service_role_key'
--               THEN '<' || length(value) || ' chars hidden>'
--               ELSE value
--          END AS value,
--          updated_at
--   FROM public.imageright_settings
--   ORDER BY name;
