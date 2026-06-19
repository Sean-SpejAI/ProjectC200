-- Address Supabase Security Advisor warnings (2026-05-21):
--   * function_search_path_mutable on public.update_updated_at_column
--   * public_bucket_allows_listing on storage bucket `claim-documents`
--   * anon_security_definer_function_executable on 7 SECURITY DEFINER funcs
--     (kept callable by `authenticated` per current intent; service_role and
--     postgres also retain EXECUTE. The matching `authenticated_*` lint will
--     stay open by design — signed-in users still call these.)

-- 1. Pin the trigger function's search_path so it can't be hijacked.
ALTER FUNCTION public.update_updated_at_column() SET search_path = '';

-- 2. Drop the listing-exposing SELECT policy on `claim-documents`. The bucket
--    is public=true, so /storage/v1/object/public/<bucket>/<path> URLs serve
--    without any policy. Removing this prevents anon callers from enumerating
--    object names via storage.objects. No app code uses .list() on this bucket.
DROP POLICY IF EXISTS "Allow public read from claim-documents" ON storage.objects;

-- 3. Revoke EXECUTE from anon and PUBLIC on the SECURITY DEFINER functions.
--    Both anon and PUBLIC carry an EXECUTE grant today (PUBLIC by Postgres
--    default; anon by explicit grant). Removing both closes the anon RPC path
--    while `authenticated`, `postgres`, and `service_role` keep their grants.
REVOKE EXECUTE ON FUNCTION public.add_processing_log(uuid, text, text, jsonb)                                 FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_can_read_mfa_status()                                                 FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_processing_job(uuid)                                                 FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_user_mfa_status()                                                       FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()                                                           FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role)                                             FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_job_progress(uuid, integer, text, text, text, text)                  FROM anon, PUBLIC;
