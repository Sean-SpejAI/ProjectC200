-- Follow-up to 20260521120000_security_advisor_warnings.sql.
--
-- Closes the remaining `authenticated_security_definer_function_executable`
-- warnings for the 4 functions that have no signed-in-user callers:
--   * handle_new_user        — auth.users insert trigger; uncallable as plain func
--   * add_processing_log     — called only by Edge Functions (service_role)
--   * create_processing_job  — called only by Edge Functions (service_role)
--   * update_job_progress    — called only by Edge Functions (service_role)
--
-- The 3 remaining SECURITY DEFINER funcs (has_role, admin_can_read_mfa_status,
-- get_user_mfa_status) stay callable by authenticated because RLS evaluation
-- and the admin UI legitimately need them.

REVOKE EXECUTE ON FUNCTION public.handle_new_user()                                                           FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.add_processing_log(uuid, text, text, jsonb)                                 FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.create_processing_job(uuid)                                                 FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.update_job_progress(uuid, integer, text, text, text, text)                  FROM authenticated;
