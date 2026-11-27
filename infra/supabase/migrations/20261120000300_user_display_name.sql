-- User display name: tighten the existing profiles.display_name (nullable) to trimmed, 1-80 chars.
--
-- Rollback / forward-fix: no column is added, so there is nothing to drop. To roll back, run
--   alter table public.profiles drop constraint profiles_display_name_valid;
--   alter table public.profiles add constraint profiles_display_name_check
--     check (display_name is null or char_length(display_name) between 1 and 100);
-- The data normalisation below (trim, empty -> null, cut to 80) is not reversible; names that were
-- longer than 80 characters stay truncated. Forward-fix by re-entering the name on /account.
--
-- Why not a new `name` column: the PRD §8 profiles table already has `display_name` (nullable) and
-- ADR-005 already grants `authenticated` UPDATE on that one column only, with the existing
-- `auth.uid() = user_id` RLS policy. A second column would be a parallel field. The API and
-- contracts call it `name`; the column keeps its documented name. No RLS or grant changes: users can
-- update only their own display_name, and email/plan_id remain service-only.

update public.profiles
set display_name = nullif(left(btrim(display_name), 80), '')
where display_name is not null
  and display_name is distinct from nullif(left(btrim(display_name), 80), '');

-- A cut at 80 can leave a trailing space; trim again, then clear if empty.
update public.profiles
set display_name = nullif(btrim(display_name), '')
where display_name is not null and display_name <> btrim(display_name);

alter table public.profiles drop constraint profiles_display_name_check;

alter table public.profiles
  add constraint profiles_display_name_valid
  check (
    display_name is null
    or (
      display_name = btrim(display_name)
      and char_length(display_name) between 1 and 80
    )
  );
