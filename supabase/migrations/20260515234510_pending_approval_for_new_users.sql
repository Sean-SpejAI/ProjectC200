-- Require admin approval before a newly-registered user can access the app.
--
-- Until 2026-05-15 the `handle_new_user` trigger auto-granted the
-- `claims_reviewer` role to every signup, which means anyone who could land
-- on the sign-up form (now publicly reachable at https://ncp.spej.dev/auth)
-- got into the app immediately. That's wrong for an internal claims portal.
--
-- This migration changes the trigger to ONLY create the profile row.
-- New users sign up, complete 2FA enrollment, but then hit the
-- PendingApprovalGate (frontend) until an admin grants them a role from the
-- User Management page.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, full_name)
    VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name');
  -- Roles are granted explicitly by admins via the User Management page.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
