-- Let any signed-in portal user read team members' profiles (full_name /
-- department) so the Review Queue can sort by the assignee's name.
--
-- The original policies only let a user see their OWN profile (+ admins see
-- all), so non-admin reviewers couldn't resolve who a claim is assigned to.
-- Profiles hold only display name + department — not sensitive within the
-- claims team, and every app user is gated behind login + an approved role.
-- SELECT only; the self-scoped INSERT/UPDATE policies are unchanged.

DROP POLICY IF EXISTS "Authenticated users can view profiles" ON public.profiles;
CREATE POLICY "Authenticated users can view profiles"
  ON public.profiles FOR SELECT TO authenticated USING (true);
