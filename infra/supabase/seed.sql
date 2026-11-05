-- Local development fixtures only (applied by `supabase db reset`). Synthetic data; never run in
-- production. Reference data (plans) lives in the migrations, not here.

-- A demo creator. handle_new_user() provisions the profile and Free billing account.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'demo-creator@example.test',
  now(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  now(),
  now()
);

insert into public.galleries (id, owner_id, slug, title)
values (
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-000000000001',
  'demoDraftGallery01',
  'Demo draft gallery'
);

-- A guest draft (24 h TTL) with no uploads yet.
insert into public.guest_sessions (id, capability_hash, expires_at)
values (
  '00000000-0000-4000-8000-0000000000b1',
  'seed-capability-hash-not-a-real-secret',
  now() + interval '24 hours'
);

insert into public.galleries (id, guest_session_id, slug)
values (
  '00000000-0000-4000-8000-0000000000a2',
  '00000000-0000-4000-8000-0000000000b1',
  'demoGuestGallery01'
);
