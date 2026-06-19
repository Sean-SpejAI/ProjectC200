-- MFA backup codes (one-time recovery codes) and admin-visible factor view.
--
-- Per session policy (2026-05-15): 2FA is required for every signed-in user.
-- Backup codes act as factor-reset codes: redeeming one wipes the user's TOTP
-- factor so they're forced to re-enroll on a new device. Stored as SHA-256
-- hashes — the plaintext is shown to the user exactly once at generation.

CREATE TABLE IF NOT EXISTS public.mfa_backup_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_user
  ON public.mfa_backup_codes (user_id);

CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_lookup
  ON public.mfa_backup_codes (user_id, code_hash) WHERE used_at IS NULL;

ALTER TABLE public.mfa_backup_codes ENABLE ROW LEVEL SECURITY;

-- Users can see metadata about their own codes (count, used vs unused) but the
-- hash column is meaningless without the matching plaintext. All writes go
-- through edge functions running with the service role.
CREATE POLICY mfa_backup_codes_owner_select
  ON public.mfa_backup_codes
  FOR SELECT
  USING (auth.uid() = user_id);

-- Admin-facing view: count of verified TOTP factors per user.
-- auth.mfa_factors is locked down by Supabase Auth's RLS, so we surface a
-- SECURITY DEFINER view that only admins can read. Used by the Admin page to
-- display "MFA enabled" badges and decide whether to expose "Reset MFA".
CREATE OR REPLACE VIEW public.user_mfa_status
WITH (security_invoker = false) AS
SELECT
  u.id AS user_id,
  COALESCE(SUM(CASE WHEN f.status = 'verified' THEN 1 ELSE 0 END), 0) AS verified_factor_count
FROM auth.users u
LEFT JOIN auth.mfa_factors f ON f.user_id = u.id
GROUP BY u.id;

REVOKE ALL ON public.user_mfa_status FROM PUBLIC;
GRANT SELECT ON public.user_mfa_status TO authenticated;

-- Only admins (via user_roles) may read the view.
CREATE OR REPLACE FUNCTION public.admin_can_read_mfa_status()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;

-- Wrap the view in a function so we can gate it by admin role.
CREATE OR REPLACE FUNCTION public.get_user_mfa_status()
RETURNS TABLE (user_id uuid, verified_factor_count bigint)
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
    COALESCE(SUM(CASE WHEN f.status = 'verified' THEN 1 ELSE 0 END), 0)::bigint AS verified_factor_count
  FROM auth.users u
  LEFT JOIN auth.mfa_factors f ON f.user_id = u.id
  GROUP BY u.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_mfa_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_mfa_status() TO authenticated;

-- SECURITY DEFINER helper that wipes a user's TOTP factors. Called by edge
-- functions running with the service role (after they've authenticated the
-- caller and authorized the action). PostgREST only exposes the `public`
-- schema, so we wrap the auth-schema delete here.
CREATE OR REPLACE FUNCTION public.admin_clear_mfa_factors(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  DELETE FROM auth.mfa_factors WHERE user_id = target_user_id;
END;
$$;

-- Only the service role may call this — direct user calls would bypass the
-- per-function authorization logic (backup-code redemption / admin-role check).
REVOKE ALL ON FUNCTION public.admin_clear_mfa_factors(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_clear_mfa_factors(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_mfa_factors(uuid) TO service_role;
