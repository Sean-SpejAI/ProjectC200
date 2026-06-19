-- Extend the admin user-status RPC with suspension state.
--
-- get_user_mfa_status previously returned just (user_id, verified_factor_count).
-- Admins now also need to know which users are suspended (Supabase Auth's
-- "ban_duration" feature — sets auth.users.banned_until in the future). We
-- replace the function with a backwards-compatible columnset plus is_suspended.

DROP FUNCTION IF EXISTS public.get_user_mfa_status();

CREATE OR REPLACE FUNCTION public.get_user_mfa_status()
RETURNS TABLE (
  user_id uuid,
  verified_factor_count bigint,
  is_suspended boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT public.admin_can_read_mfa_status() THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT
    u.id AS user_id,
    COALESCE(SUM(CASE WHEN f.status = 'verified' THEN 1 ELSE 0 END), 0)::bigint
      AS verified_factor_count,
    (u.banned_until IS NOT NULL AND u.banned_until > now()) AS is_suspended
  FROM auth.users u
  LEFT JOIN auth.mfa_factors f ON f.user_id = u.id
  GROUP BY u.id, u.banned_until;
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_mfa_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_mfa_status() TO authenticated;
