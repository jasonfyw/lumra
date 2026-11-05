/**
 * Harness for route-handler integration tests: a fake request context (signed-in user + cookie
 * jar, see mocks.ts) and fixtures written straight to the local Supabase Postgres.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  GUEST_COOKIE_NAME,
  generateGuestCapability,
  hashGuestCapability,
} from '../src/lib/guest-capability';

export { ctx } from './context';
import { ctx } from './context';

/** Raw postgres.js client for fixtures (a separate pool from the handlers' `getDb()`). */
export const sql = postgres(process.env.DATABASE_URL!, {
  max: 5,
  onnotice: () => {},
  prepare: false,
});

const createdUsers: string[] = [];
const createdGuestSessions: string[] = [];

export function signInAs(userId: string | null) {
  ctx.user = userId ? { id: userId, email: `${userId}@example.test` } : null;
}

export function resetContext() {
  ctx.user = null;
  ctx.cookies.clear();
}

export async function createUser(plan: 'free' | 'pro' = 'free'): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`${id}@example.test`}, '{}', '{}')`;
  if (plan === 'pro') await sql`update public.profiles set plan_id = 'pro' where user_id = ${id}`;
  createdUsers.push(id);
  return id;
}

export function slug(): string {
  return randomUUID().replaceAll('-', '').slice(0, 20);
}

export async function createOwnedGallery(
  ownerId: string,
  extra: { deleted?: boolean; title?: string } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into public.galleries (owner_id, slug, title, status, deleted_at)
    values (${ownerId}, ${slug()}, ${extra.title ?? 'Owned gallery'},
            ${extra.deleted ? 'deleted' : 'draft'}, ${extra.deleted ? new Date() : null})
    returning id`;
  return row!.id;
}

export interface GuestDraft {
  guestSessionId: string;
  galleryId: string;
  capability: string;
  uploadSessionId: string;
  mediaId: string;
}

/** A guest session (24 h TTL unless `expired`) owning one draft with one in-flight upload. */
export async function createGuestDraft(opts: { expired?: boolean } = {}): Promise<GuestDraft> {
  const capability = generateGuestCapability();
  const hash = await hashGuestCapability(capability, process.env.GUEST_CAPABILITY_PEPPER!);
  const expiresAt = new Date(Date.now() + (opts.expired ? -60_000 : 24 * 3600_000));
  const [session] = await sql<{ id: string }[]>`
    insert into public.guest_sessions (capability_hash, expires_at, reserved_file_count, reserved_bytes)
    values (${hash}, ${expiresAt}, 1, 1000) returning id`;
  createdGuestSessions.push(session!.id);
  const [gallery] = await sql<{ id: string }[]>`
    insert into public.galleries (guest_session_id, slug) values (${session!.id}, ${slug()})
    returning id`;
  const mediaId = randomUUID();
  await sql`
    insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key, status)
    values (${mediaId}, ${gallery!.id}, ${`originals/g/${gallery!.id}/${mediaId}/source`},
            'IMG_1.jpg', 'image/jpeg', 1000, 'a0', 'uploading')`;
  const [upload] = await sql<{ id: string }[]>`
    insert into public.upload_sessions (gallery_id, media_id, part_size, reserved_bytes, expires_at, idempotency_key)
    values (${gallery!.id}, ${mediaId}, 8388608, 1000, ${expiresAt}, ${randomUUID()})
    returning id`;
  await sql`update public.media set upload_session_id = ${upload!.id} where id = ${mediaId}`;
  return {
    guestSessionId: session!.id,
    galleryId: gallery!.id,
    capability,
    uploadSessionId: upload!.id,
    mediaId,
  };
}

export function useGuestCookie(draft: Pick<GuestDraft, 'capability'> | null) {
  if (draft) ctx.cookies.set(GUEST_COOKIE_NAME, draft.capability);
  else ctx.cookies.delete(GUEST_COOKIE_NAME);
}

export async function cleanup() {
  if (createdGuestSessions.length) {
    await sql`delete from public.galleries where guest_session_id in ${sql(createdGuestSessions)}`;
  }
  if (createdUsers.length) {
    await sql`delete from public.galleries where owner_id in ${sql(createdUsers)}`;
  }
  if (createdGuestSessions.length) {
    await sql`delete from public.guest_sessions where id in ${sql(createdGuestSessions)}`;
  }
  if (createdUsers.length) {
    await sql`delete from public.billing_accounts where user_id in ${sql(createdUsers)}`;
    await sql`delete from auth.users where id in ${sql(createdUsers)}`;
  }
  await sql.end();
}

export function jsonRequest(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  return new Request(new URL(url, 'http://localhost:3000'), {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export async function readJson<T = unknown>(res: Response) {
  return (await res.json()) as {
    data: T | null;
    error: { code: string; message: string } | null;
    requestId: string;
  };
}
