-- T02: auth.users -> profiles/billing_accounts provisioning and atomic guest quota reservation.

-- ---------------------------------------------------------------------------------------------
-- handle_new_user: every new auth user gets a profile on the Free plan and a Free
-- billing account. SECURITY DEFINER because it runs in the auth schema's insert context.
-- ---------------------------------------------------------------------------------------------

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email, plan_id)
  values (new.id, coalesce(new.email, ''), 'free')
  on conflict (user_id) do nothing;

  insert into public.billing_accounts (user_id, status)
  values (new.id, 'free')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------------------------
-- reserve_guest_upload (FR-A02, PRD §11 "Guest concurrently reserves 21 files"): a single
-- conditional UPDATE so concurrent callers serialise on the row lock and re-check the predicate.
-- Returns true when the reservation was recorded, false when the session is unknown, expired,
-- already claimed, or the reservation would exceed 20 files / 250,000,000 bytes.
-- Limits mirror GUEST_LIMITS in packages/config/src/limits.ts. Service role only.
-- ---------------------------------------------------------------------------------------------

create function public.reserve_guest_upload(guest_session_id uuid, file_bytes bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  reserved boolean;
begin
  if file_bytes is null or file_bytes <= 0 then
    return false;
  end if;

  update public.guest_sessions gs
  set reserved_file_count = gs.reserved_file_count + 1,
      reserved_bytes = gs.reserved_bytes + reserve_guest_upload.file_bytes
  where gs.id = reserve_guest_upload.guest_session_id
    and gs.expires_at > now()
    and gs.claimed_at is null
    and gs.reserved_file_count + 1 <= 20
    and gs.reserved_bytes + reserve_guest_upload.file_bytes <= 250000000
  returning true into reserved;

  return coalesce(reserved, false);
end;
$$;

revoke all on function public.reserve_guest_upload(uuid, bigint) from public, anon, authenticated;
grant execute on function public.reserve_guest_upload(uuid, bigint) to service_role;
