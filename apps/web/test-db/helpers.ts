/** Fixtures and request helpers for route integration tests (see setup.ts). */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { POST as createDraft } from '@/app/api/v1/guest/drafts/route';
import { GUEST_COOKIE_NAME } from '@/lib/guest-capability';
import type { TestRequestState } from './setup';

export const state = (globalThis as unknown as { __lumraTestState: TestRequestState })
  .__lumraTestState;

export const sql = postgres(process.env.DATABASE_URL!, {
  max: 5,
  prepare: false,
  onnotice: () => {},
});

const created = { users: [] as string[], guests: [] as string[], galleries: [] as string[] };

export async function cleanup(): Promise<void> {
  if (created.galleries.length) {
    await sql`delete from public.job_outbox where aggregate_id in (
      select id from public.media where gallery_id in ${sql(created.galleries)})`;
    await sql`delete from public.galleries where id in ${sql(created.galleries.splice(0))}`;
  }
  if (created.guests.length) {
    await sql`delete from public.galleries where guest_session_id in ${sql(created.guests)}`;
    await sql`delete from public.guest_sessions where id in ${sql(created.guests.splice(0))}`;
  }
  if (created.users.length) {
    await sql`delete from public.galleries where owner_id in ${sql(created.users)}`;
    await sql`delete from auth.users where id in ${sql(created.users.splice(0))}`;
  }
}

export function trackGuest(id: string): void {
  created.guests.push(id);
}

export async function createUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await sql`
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email}, '{}', '{}')`;
  created.users.push(id);
  return { id, email };
}

export async function createOwnedGallery(ownerId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into public.galleries (owner_id, slug)
    values (${ownerId}, ${randomUUID().replaceAll('-', '').slice(0, 20)}) returning id`;
  created.galleries.push(row!.id);
  return row!.id;
}

/** Who the next requests are made as. */
export function actAs(actor: { user?: { id: string; email: string }; guestCookie?: string }) {
  state.user = actor.user ?? null;
  state.cookies.clear();
  if (actor.guestCookie) state.cookies.set(GUEST_COOKIE_NAME, actor.guestCookie);
}

/** A fresh client IP (random IPv6 /64) per call so rate-limit buckets never leak between runs. */
export function freshIp(): string {
  const hex = randomUUID().replaceAll('-', '');
  return `2001:db8:${hex.slice(0, 4)}:${hex.slice(4, 8)}::${hex.slice(8, 12)}`;
}

export function jsonRequest(
  path: string,
  body?: unknown,
  init: { method?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(`https://lumra.test${path}`, {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': freshIp(),
      ...init.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const params = (id: string) => ({ params: Promise.resolve({ id }) });

export async function readJson<T = Record<string, unknown>>(res: Response) {
  return (await res.json()) as {
    data: T;
    error: { code: string; message: string; details?: Record<string, unknown> } | null;
  };
}

export async function guestUsage(guestSessionId: string) {
  const [row] = await sql<{ files: number; bytes: string }[]>`
    select reserved_file_count as files, reserved_bytes::text as bytes
    from public.guest_sessions where id = ${guestSessionId}`;
  return { files: row!.files, bytes: Number(row!.bytes) };
}

/** Creates a guest draft through the real route and returns the capability cookie value. */
export async function newDraft(ip = freshIp()) {
  actAs({});
  const res = await createDraft(
    jsonRequest('/api/v1/guest/drafts', {}, { headers: { 'x-forwarded-for': ip } }),
    undefined,
  );
  const setCookie = res.headers.get('set-cookie') ?? '';
  const capability = /lumra_guest=([^;]+)/.exec(setCookie)?.[1] ?? '';
  const body = await readJson<{ galleryId: string; draftExpiresAt: string }>(res);
  const [row] = await sql<{ guest_session_id: string }[]>`
    select guest_session_id from public.galleries where id = ${body.data?.galleryId ?? null}`;
  if (row) trackGuest(row.guest_session_id);
  return { res, setCookie, capability, body, guestSessionId: row?.guest_session_id ?? '' };
}
