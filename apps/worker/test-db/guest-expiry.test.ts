/**
 * Guest draft expiry (FR-A03) against local Supabase: the real deletion repository expires only
 * unclaimed drafts of expired guest sessions, enqueues exactly one `gallery.delete` per gallery,
 * and a rerun changes nothing.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDeletionRepository, createSqlClient, pgArray } from '@lumra/db';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const sql = createSqlClient(DATABASE_URL, { max: 4, prepare: true, statementTimeoutMs: 0 });

const galleries: string[] = [];
const sessions: string[] = [];

afterAll(async () => {
  if (galleries.length) {
    await sql`delete from public.job_outbox where aggregate_id = any(${pgArray(galleries)}::uuid[])`;
    await sql`delete from public.galleries where id = any(${pgArray(galleries)}::uuid[])`;
  }
  if (sessions.length)
    await sql`delete from public.guest_sessions where id = any(${pgArray(sessions)}::uuid[])`;
  await sql.end();
});

async function seedDraft(expiresIn: string, claimed = false) {
  const [s] = await sql<{ id: string }[]>`
    insert into public.guest_sessions (capability_hash, expires_at, claimed_at)
    values (${randomUUID()}, now() + ${expiresIn}::interval, ${claimed ? sql`now()` : null})
    returning id`;
  sessions.push(s!.id);
  const [g] = await sql<{ id: string }[]>`
    insert into public.galleries (guest_session_id, slug, status)
    values (${s!.id}, ${randomUUID().replaceAll('-', '').slice(0, 20)}, 'draft')
    returning id`;
  galleries.push(g!.id);
  return { gallery: g!.id, session: s!.id };
}

const row = async (id: string) =>
  (
    await sql<{ status: string; deleted: boolean; version: number }[]>`
      select status, deleted_at is not null as deleted, access_version as version
      from public.galleries where id = ${id}`
  )[0];

describe('expireGuestDrafts (db)', () => {
  it('soft-deletes expired unclaimed drafts only and enqueues one gallery.delete each', async () => {
    const repo = createDeletionRepository(sql);
    const expired = await seedDraft('-1 hour');
    const live = await seedDraft('1 hour');
    const claimed = await seedDraft('-1 hour', true);
    const [media] = await sql<{ id: string }[]>`
      insert into public.media (gallery_id, original_key, filename, mime, byte_size, sort_key, status)
      values (${expired.gallery}, ${`originals/guest-123456/${expired.gallery}/${randomUUID()}/source`},
              'a.jpg', 'image/jpeg', 10, 'a', 'ready')
      returning id`;
    const [upload] = await sql<{ id: string }[]>`
      insert into public.upload_sessions (gallery_id, media_id, part_size, reserved_bytes, expires_at,
                                          idempotency_key)
      values (${expired.gallery}, ${media!.id}, 5242880, 10, now() + interval '1 hour', ${randomUUID()})
      returning id`;

    const ids = await repo.expireGuestDrafts(new Date(), 1000);
    expect(ids).toContain(expired.gallery);
    expect(ids).not.toContain(live.gallery);
    expect(ids).not.toContain(claimed.gallery);

    expect(await row(expired.gallery)).toEqual({ status: 'deleted', deleted: true, version: 2 });
    expect(await row(live.gallery)).toEqual({ status: 'draft', deleted: false, version: 1 });
    expect(await row(claimed.gallery)).toEqual({ status: 'draft', deleted: false, version: 1 });

    const [u] = await sql<{ status: string }[]>`
      select status from public.upload_sessions where id = ${upload!.id}`;
    expect(u!.status).toBe('expired');

    const outbox = await sql<{ event_name: string; payload: { galleryId: string } }[]>`
      select event_name, payload from public.job_outbox where aggregate_id = ${expired.gallery}`;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      event_name: 'gallery.delete',
      payload: { type: 'gallery.delete', galleryId: expired.gallery },
    });

    // Idempotent: the deleted draft is never selected (or enqueued) again.
    expect(await repo.expireGuestDrafts(new Date(), 1000)).not.toContain(expired.gallery);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.job_outbox where aggregate_id = ${expired.gallery}`;
    expect(n).toBe(1);
  });
});
