import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { GalleryListItem, GalleryListResponse } from '@lumra/contracts';
import { isValidSlug } from '@lumra/domain';
import { GET as list, POST as create } from '../src/app/api/v1/galleries/route';
import {
  cleanup,
  createGuestDraft,
  createOwnedGallery,
  createUser,
  jsonRequest,
  readJson,
  resetContext,
  signInAs,
  sql,
} from './setup';

const get = (query = '') => list(jsonRequest(`/api/v1/galleries${query}`, { method: 'GET' }), {});
const post = (body?: unknown, headers?: Record<string, string>) =>
  create(jsonRequest('/api/v1/galleries', { body, headers }), {});

beforeEach(resetContext);
afterAll(cleanup);

describe('authorization', () => {
  it('401 for unauthenticated list and create', async () => {
    expect((await get()).status).toBe(401);
    const res = await post({});
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe('unauthenticated');
  });

  it('a guest cookie alone is not an authenticated owner', async () => {
    const draft = await createGuestDraft();
    const { ctx } = await import('./context');
    ctx.cookies.set('lumra_guest', draft.capability);
    expect((await get()).status).toBe(401);
    expect((await post({})).status).toBe(401);
  });

  it('lists only the caller’s own non-deleted galleries (owner-only)', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const mine = await createOwnedGallery(a, { title: 'Mine' });
    await createOwnedGallery(a, { deleted: true });
    const theirs = await createOwnedGallery(b, { title: 'Theirs' });
    await createGuestDraft();

    signInAs(a);
    const body = await readJson<GalleryListResponse>(await get());
    expect(body.data!.items.map((g) => g.id)).toEqual([mine]);
    expect(JSON.stringify(body)).not.toContain(theirs);
  });

  it('rejects cross-origin creates', async () => {
    signInAs(await createUser());
    expect((await post({}, { origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('POST /api/v1/galleries', () => {
  it('creates a draft with the default title and a random slug', async () => {
    const user = await createUser();
    signInAs(user);
    const res = await post();
    expect(res.status).toBe(201);
    const { data } = await readJson<GalleryListItem>(res);
    expect(data).toMatchObject({
      title: 'Untitled gallery',
      status: 'draft',
      itemCount: 0,
      storedBytes: 0,
      views: 0,
      downloads: 0,
    });
    expect(isValidSlug(data!.slug)).toBe(true);
    const [row] = await sql<
      { owner_id: string }[]
    >`select owner_id from public.galleries where id = ${data!.id}`;
    expect(row!.owner_id).toBe(user);
  });

  it('validates the title and the Idempotency-Key header', async () => {
    signInAs(await createUser());
    expect((await post({ title: '' })).status).toBe(422);
    expect((await post({ title: 'x'.repeat(201) })).status).toBe(422);
    expect((await post({}, { 'idempotency-key': 'bad key!' })).status).toBe(422);
    const named = await readJson<GalleryListItem>(await post({ title: '  Wedding  ' }));
    expect(named.data!.title).toBe('Wedding');
  });

  it('enforces the Free cap of 2 active galleries with 403 quota_exceeded', async () => {
    const user = await createUser('free');
    signInAs(user);
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    const res = await post();
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error).toMatchObject({ code: 'quota_exceeded' });
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.galleries where owner_id = ${user}`;
    expect(row!.n).toBe(2);
  });

  it('Pro has no gallery cap', async () => {
    signInAs(await createUser('pro'));
    for (let i = 0; i < 3; i++) expect((await post()).status).toBe(201);
  });

  it('honours Idempotency-Key: replays return the same gallery, even concurrently', async () => {
    const user = await createUser('free');
    signInAs(user);
    const key = randomUUID();
    const first = await post({ title: 'Trip' }, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    const replay = await post({ title: 'Trip' }, { 'idempotency-key': key });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    const [a, b] = [
      await readJson<GalleryListItem>(first),
      await readJson<GalleryListItem>(replay),
    ];
    expect(b.data!.id).toBe(a.data!.id);

    const key2 = randomUUID();
    const burst = await Promise.all(
      Array.from({ length: 5 }, () => post({}, { 'idempotency-key': key2 })),
    );
    const ids = new Set(
      await Promise.all(burst.map(async (r) => (await readJson<GalleryListItem>(r)).data!.id)),
    );
    expect(ids.size).toBe(1);
    expect(burst.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);

    // Replays work even at the cap (the gallery already exists) and the same key from another
    // user creates that user's own gallery.
    expect((await post({}, { 'idempotency-key': key })).status).toBe(200);
    signInAs(await createUser());
    const other = await readJson<GalleryListItem>(await post({}, { 'idempotency-key': key }));
    expect(other.data!.id).not.toBe(a.data!.id);
  });
});

describe('GET /api/v1/galleries', () => {
  it('reports item count, stored bytes and computed expired status', async () => {
    const user = await createUser();
    const g = await createOwnedGallery(user, { title: 'Stats' });
    const media = [
      { status: 'ready', bytes: 1_000_000, variant: 50_000 },
      { status: 'uploading', bytes: 2_000_000, variant: 0 },
      { status: 'ready', bytes: 4_000_000, variant: 70_000, deleted: true },
    ];
    for (const [i, m] of media.entries()) {
      const id = randomUUID();
      await sql`
        insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key, status, ready_at, deleted_at)
        values (${id}, ${g}, ${`originals/u/${g}/${id}/source`}, 'p.jpg', 'image/jpeg', ${m.bytes},
                ${`a${i}`}, ${m.deleted ? 'deleting' : m.status}, ${m.status === 'ready' ? new Date() : null},
                ${m.deleted ? new Date() : null})`;
      if (m.variant) {
        await sql`
          insert into public.media_variants (media_id, variant, object_key, mime, width, height, byte_size)
          values (${id}, 'w320', ${`derivatives/${g}/${id}/w320.webp`}, 'image/webp', 320, 240, ${m.variant})`;
      }
    }
    await sql`update public.galleries set status = 'published', published_at = now(),
              expires_at = now() - interval '1 hour' where id = ${g}`;

    signInAs(user);
    const { data } = await readJson<GalleryListResponse>(await get());
    expect(data!.items).toHaveLength(1);
    expect(data!.items[0]).toMatchObject({
      id: g,
      status: 'expired',
      itemCount: 2,
      storedBytes: 1_050_000, // ready original + its variant; uploading and deleted excluded
    });
  });

  it('rejects bad limits and cursors with 422', async () => {
    signInAs(await createUser());
    expect((await get('?limit=0')).status).toBe(422);
    expect((await get('?limit=101')).status).toBe(422);
    expect((await get('?limit=abc')).status).toBe(422);
    expect((await get('?cursor=garbage!')).status).toBe(422);
  });

  it('paginates 1,000 galleries by (updated_at desc, id desc) without gaps or repeats', async () => {
    const user = await createUser('pro');
    // 1,000 rows over 250 distinct timestamps (4-way ties) with microsecond offsets, so the id
    // tie-break and full timestamp precision are both exercised.
    await sql`
      insert into public.galleries (owner_id, slug, title, created_at, updated_at)
      select ${user}::uuid, 'seed' || md5(random()::text || n)::text, 'Seed ' || n,
             timestamptz '2026-01-01' + (n / 4) * interval '1 minute',
             timestamptz '2026-01-01' + (n / 4) * interval '1 minute' + (n % 2) * interval '1 microsecond'
      from generate_series(1, 1000) as n`;
    // One deleted row that must never appear.
    await createOwnedGallery(user, { deleted: true });

    const expected = (
      await sql<{ id: string }[]>`
        select id from public.galleries where owner_id = ${user} and deleted_at is null
        order by updated_at desc, id desc`
    ).map((r) => r.id);
    expect(expected).toHaveLength(1000);

    signInAs(user);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      const body = await readJson<GalleryListResponse>(res);
      expect(body.data!.items.length).toBeLessThanOrEqual(100);
      seen.push(...body.data!.items.map((g) => g.id));
      cursor = body.data!.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);

    expect(pages).toBe(10);
    expect(new Set(seen).size).toBe(1000);
    expect(seen).toEqual(expected);

    // Default page size.
    const first = await readJson<GalleryListResponse>(await get());
    expect(first.data!.items).toHaveLength(25);
  });
});
