/**
 * T15/T16/T19 creator endpoints against the local Supabase Postgres: authorization for every
 * mutation, publish semantics, password/access-version, deletion, reorder, cover and media
 * delete. Route handlers run for real (see setup.ts for what is faked).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  DeleteGalleryResponse,
  DeleteMediaResponse,
  GalleryDetail,
  PublishGalleryResponse,
  ReorderMediaResponse,
  SetGalleryPasswordResponse,
} from '@lumra/contracts';
import { mediaTokenKeyringSchema } from '@lumra/config';
import { verifyMediaToken } from '@lumra/tokens';
import { verifyGalleryPassword } from '@/lib/password';
import {
  DELETE as deleteGalleryRoute,
  GET as getGalleryRoute,
  PATCH as patchGalleryRoute,
} from '@/app/api/v1/galleries/[id]/route';
import { POST as publishRoute } from '@/app/api/v1/galleries/[id]/publish/route';
import { PUT as passwordRoute } from '@/app/api/v1/galleries/[id]/password/route';
import { PATCH as orderRoute } from '@/app/api/v1/galleries/[id]/media/order/route';
import { DELETE as deleteMediaRoute } from '@/app/api/v1/galleries/[id]/media/[mediaId]/route';
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
  useGuestCookie,
} from './fixtures';

const p = (id: string) => ({ params: Promise.resolve({ id }) });
const base = (id: string) => `/api/v1/galleries/${id}`;

const api = {
  get: (id: string) => getGalleryRoute(jsonRequest(base(id), { method: 'GET' }), p(id)),
  patch: (id: string, body: unknown, headers?: Record<string, string>) =>
    patchGalleryRoute(jsonRequest(base(id), { method: 'PATCH', body, headers }), p(id)),
  del: (id: string, headers?: Record<string, string>) =>
    deleteGalleryRoute(jsonRequest(base(id), { method: 'DELETE', headers }), p(id)),
  publish: (id: string, body: unknown = {}, headers?: Record<string, string>) =>
    publishRoute(jsonRequest(`${base(id)}/publish`, { body, headers }), p(id)),
  password: (id: string, body: unknown, headers?: Record<string, string>) =>
    passwordRoute(jsonRequest(`${base(id)}/password`, { method: 'PUT', body, headers }), p(id)),
  order: (id: string, orderedIds: string[], headers?: Record<string, string>) =>
    orderRoute(
      jsonRequest(`${base(id)}/media/order`, { method: 'PATCH', body: { orderedIds }, headers }),
      p(id),
    ),
  delMedia: (id: string, mediaId: string, headers?: Record<string, string>) =>
    deleteMediaRoute(jsonRequest(`${base(id)}/media/${mediaId}`, { method: 'DELETE', headers }), {
      params: Promise.resolve({ id, mediaId }),
    }),
};

async function addMedia(
  galleryId: string,
  sortKey: string,
  status = 'ready',
  extra: { createdAt?: Date } = {},
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key,
                              status, ready_at, width, height, created_at)
    values (${id}, ${galleryId}, ${`originals/test/${galleryId}/${id}/source`}, ${`IMG_${sortKey}.jpg`},
            'image/jpeg', 1000, ${sortKey}, ${status}, ${status === 'ready' ? new Date() : null},
            ${status === 'ready' ? 4000 : null}, ${status === 'ready' ? 3000 : null},
            ${extra.createdAt ?? new Date()})`;
  return id;
}

async function galleryRow(id: string) {
  const [row] = await sql<
    {
      status: string;
      slug: string;
      title: string;
      published_at: Date | null;
      deleted_at: Date | null;
      access_version: number;
      content_version: number;
      password_hash: string | null;
      cover_media_id: string | null;
      expires_at: Date | null;
    }[]
  >`select * from public.galleries where id = ${id}`;
  return row!;
}

async function outbox(aggregateId: string) {
  return sql<{ event_name: string; payload: Record<string, unknown>; dedupe_key: string }[]>`
    select event_name, payload, dedupe_key from public.job_outbox
    where aggregate_id = ${aggregateId} order by created_at`;
}

async function orderOf(galleryId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from public.media where gallery_id = ${galleryId} and deleted_at is null
    order by sort_key collate "C", id`;
  return rows.map((r) => r.id);
}

async function ownedWithUser() {
  const user = await createUser('pro');
  const gallery = await createOwnedGallery(user, { title: 'Trip' });
  signInAs(user);
  return { user, gallery };
}

const future = (ms = 7 * 24 * 3600_000) => new Date(Date.now() + ms).toISOString();

beforeEach(resetContext);
afterAll(cleanup);

// ---------------------------------------------------------------------------------------------

describe('authorization (every endpoint)', () => {
  const calls = (g: string, m: string) =>
    [
      ['GET detail', () => api.get(g)],
      ['PATCH', () => api.patch(g, { title: 'x' })],
      ['DELETE', () => api.del(g)],
      ['publish', () => api.publish(g)],
      ['password', () => api.password(g, { password: 'secret-1' })],
      ['order', () => api.order(g, [m])],
      ['delete media', () => api.delMedia(g, m)],
    ] as const;

  it('401 for unauthenticated callers', async () => {
    const owner = await createUser();
    const g = await createOwnedGallery(owner);
    const m = await addMedia(g, 'a0');
    for (const [name, call] of calls(g, m)) {
      const res = await call();
      expect(res.status, name).toBe(401);
      expect((await readJson(res)).error?.code, name).toBe('unauthenticated');
    }
    const row = await galleryRow(g);
    expect(row.status).toBe('draft');
    expect(row.deleted_at).toBeNull();
  });

  it('concealed 404 for another signed-in user; nothing changes', async () => {
    const owner = await createUser();
    const g = await createOwnedGallery(owner, { title: 'Private' });
    const m = await addMedia(g, 'a0');
    signInAs(await createUser());
    for (const [name, call] of calls(g, m)) {
      const res = await call();
      expect(res.status, name).toBe(404);
      const body = await readJson(res);
      expect(body.error?.code, name).toBe('not_found');
      expect(JSON.stringify(body)).not.toContain('Private');
    }
    const row = await galleryRow(g);
    expect(row).toMatchObject({ status: 'draft', title: 'Private', password_hash: null });
    expect(await outbox(g)).toHaveLength(0);
    const [media] = await sql<
      { status: string }[]
    >`select status from public.media where id = ${m}`;
    expect(media!.status).toBe('ready');
  });

  it('a guest cannot publish or edit (401); a signed-in user must claim first (404)', async () => {
    const draft = await createGuestDraft();
    useGuestCookie(draft);
    const guestRes = await api.publish(draft.galleryId);
    expect(guestRes.status).toBe(401);
    expect((await readJson(guestRes)).error?.message).toMatch(/Sign in to publish/);
    expect((await api.patch(draft.galleryId, { title: 'x' })).status).toBe(401);

    // Signed in but the draft is still the guest's (not claimed): concealed.
    signInAs(await createUser());
    useGuestCookie(draft);
    expect((await api.publish(draft.galleryId)).status).toBe(404);
    expect((await galleryRow(draft.galleryId)).status).toBe('draft');
  });

  it('404 for malformed ids and deleted galleries', async () => {
    const { user } = await ownedWithUser();
    expect((await api.get('not-a-uuid')).status).toBe(404);
    const deleted = await createOwnedGallery(user, { deleted: true });
    expect((await api.get(deleted)).status).toBe(404);
    expect((await api.publish(deleted)).status).toBe(404);
  });

  it('rejects cross-origin mutations and non-JSON bodies', async () => {
    const { gallery } = await ownedWithUser();
    const evil = { origin: 'https://evil.example' };
    expect((await api.patch(gallery, { title: 'x' }, evil)).status).toBe(403);
    expect((await api.publish(gallery, {}, evil)).status).toBe(403);
    expect((await api.del(gallery, evil)).status).toBe(403);
    expect((await api.password(gallery, { password: 'abcd1234' }, evil)).status).toBe(403);
    const form = await patchGalleryRoute(
      new Request(`http://localhost:3000${base(gallery)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ title: 'x' }),
      }),
      p(gallery),
    );
    expect(form.status).toBe(422);
    expect((await galleryRow(gallery)).status).toBe('draft');
  });
});

// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/galleries/{id}', () => {
  it('returns ordered items with creator-visible statuses (incl. failed)', async () => {
    const { gallery } = await ownedWithUser();
    const a = await addMedia(gallery, 'a1', 'ready', { createdAt: new Date(Date.now() - 2000) });
    const b = await addMedia(gallery, 'a0', 'failed');
    const c = await addMedia(gallery, 'a2', 'processing');
    await sql`update public.media set failure_code = 'upload_expired' where id = ${b}`;
    const res = await api.get(gallery);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { data } = await readJson<GalleryDetail>(res);
    expect(data!.items.map((i) => i.id)).toEqual([b, a, c]);
    expect(data!.items.map((i) => i.status)).toEqual(['failed', 'ready', 'processing']);
    expect(data!.items[0]!.failureCode).toBe('upload_expired');
    expect(data).toMatchObject({
      status: 'draft',
      accessState: 'draft',
      shareUrl: null,
      hasPassword: false,
      itemCount: 3,
      effectiveCoverMediaId: a,
    });
  });
});

describe('editor thumbnails (owner-scoped media URLs)', () => {
  const keyring = mediaTokenKeyringSchema.parse(process.env.MEDIA_TOKEN_SECRET);
  const MEDIA_BASE = 'https://media.lumra.test/m/';

  async function addVariants(galleryId: string, mediaId: string, widths: number[]) {
    for (const w of widths) {
      await sql`
        insert into public.media_variants (media_id, variant, object_key, mime, width, height, byte_size)
        values (${mediaId}, ${`w${w}`}, ${`derivatives/${galleryId}/${mediaId}/w${w}abc1234.webp`},
                'image/webp', ${w}, ${Math.round((w * 3) / 4)}, 100)`;
    }
  }

  async function claimsOf(url: string | null) {
    expect(url?.startsWith(MEDIA_BASE)).toBe(true);
    const verified = await verifyMediaToken(url!.slice(MEDIA_BASE.length), keyring);
    expect(verified.status).toBe('ok');
    return verified.status === 'ok' ? verified.claims : null;
  }

  it('owner gets a w640 owner-scoped preview URL per ready item, even for a draft', async () => {
    const { gallery } = await ownedWithUser();
    const ready = await addMedia(gallery, 'a0');
    await addVariants(gallery, ready, [320, 640, 1280]);
    const small = await addMedia(gallery, 'a1');
    await addVariants(gallery, small, [320]);
    const noDerivative = await addMedia(gallery, 'a2');
    const processing = await addMedia(gallery, 'a3', 'processing');
    const failed = await addMedia(gallery, 'a4', 'failed');

    const { data } = await readJson<GalleryDetail>(await api.get(gallery));
    expect(data!.status).toBe('draft');
    const byId = new Map(data!.items.map((i) => [i.id, i.thumbnailUrl]));
    expect(await claimsOf(byId.get(ready)!)).toMatchObject({
      action: 'preview',
      scope: 'owner',
      gallery_id: gallery,
      media_id: ready,
      variant: 'w640',
      variant_hash: 'w640abc1234',
      access_version: (await galleryRow(gallery)).access_version,
    });
    expect(await claimsOf(byId.get(small)!)).toMatchObject({ variant: 'w320', media_id: small });
    expect(byId.get(noDerivative)).toBeNull();
    expect(byId.get(processing)).toBeNull();
    expect(byId.get(failed)).toBeNull();
  });

  it('PATCH responses carry fresh thumbnails too', async () => {
    const { gallery } = await ownedWithUser();
    const ready = await addMedia(gallery, 'a0');
    await addVariants(gallery, ready, [640]);
    const { data } = await readJson<GalleryDetail>(await api.patch(gallery, { title: 'Renamed' }));
    expect(await claimsOf(data!.items[0]!.thumbnailUrl)).toMatchObject({
      action: 'preview',
      scope: 'owner',
    });
  });

  it('non-owners, guests and anonymous callers never receive media URLs', async () => {
    const owner = await createUser();
    const gallery = await createOwnedGallery(owner);
    const ready = await addMedia(gallery, 'a0');
    await addVariants(gallery, ready, [320, 640]);

    const anonymous = await api.get(gallery);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain('media.lumra.test');

    signInAs(await createUser());
    for (const res of [await api.get(gallery), await api.patch(gallery, { title: 'x' })]) {
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('media.lumra.test');
    }

    const draft = await createGuestDraft();
    resetContext();
    useGuestCookie(draft);
    const guest = await api.get(draft.galleryId);
    expect(guest.status).toBe(401);
    expect(await guest.text()).not.toContain('media.lumra.test');
  });
});

// ---------------------------------------------------------------------------------------------

describe('PATCH /api/v1/galleries/{id}', () => {
  it('renames without touching the slug (stable URL)', async () => {
    const { gallery } = await ownedWithUser();
    const before = await galleryRow(gallery);
    const res = await api.patch(gallery, { title: '  Wedding day  ' });
    expect(res.status).toBe(200);
    const { data } = await readJson<GalleryDetail>(res);
    expect(data!.title).toBe('Wedding day');
    expect(data!.slug).toBe(before.slug);
    await api.publish(gallery);
    await api.patch(gallery, { title: 'Renamed after publish' });
    expect((await galleryRow(gallery)).slug).toBe(before.slug);
  });

  it('validates the body', async () => {
    const { gallery } = await ownedWithUser();
    expect((await api.patch(gallery, {})).status).toBe(422);
    expect((await api.patch(gallery, { title: '' })).status).toBe(422);
    expect((await api.patch(gallery, { title: 'x'.repeat(201) })).status).toBe(422);
    expect((await api.patch(gallery, { slug: 'mine' })).status).toBe(422);
    expect((await api.patch(gallery, { coverMediaId: 'nope' })).status).toBe(422);
  });

  it('cover must be a non-deleted photo of this gallery, or null', async () => {
    const { user, gallery } = await ownedWithUser();
    const mine = await addMedia(gallery, 'a0', 'processing');
    const other = await createOwnedGallery(user);
    const foreign = await addMedia(other, 'a0');
    const gone = await addMedia(gallery, 'a1');
    await sql`update public.media set status = 'deleting', deleted_at = now() where id = ${gone}`;

    expect((await api.patch(gallery, { coverMediaId: foreign })).status).toBe(422);
    expect((await api.patch(gallery, { coverMediaId: gone })).status).toBe(422);
    expect((await api.patch(gallery, { coverMediaId: randomUUID() })).status).toBe(422);

    const set = await readJson<GalleryDetail>(await api.patch(gallery, { coverMediaId: mine }));
    expect(set.data!.coverMediaId).toBe(mine);
    // Not ready yet → the hero falls back (here: no ready photo at all).
    expect(set.data!.effectiveCoverMediaId).toBeNull();

    const cleared = await readJson<GalleryDetail>(await api.patch(gallery, { coverMediaId: null }));
    expect(cleared.data!.coverMediaId).toBeNull();
    expect((await galleryRow(gallery)).cover_media_id).toBeNull();
  });

  it('expiry: future UTC or null; past/far/offset rejected; changes enqueue access sync', async () => {
    const { gallery } = await ownedWithUser();
    expect((await api.patch(gallery, { expiresAt: '2020-01-01T00:00:00Z' })).status).toBe(422);
    expect((await api.patch(gallery, { expiresAt: '2999-01-01T00:00:00Z' })).status).toBe(422);
    expect((await api.patch(gallery, { expiresAt: '2030-01-01T00:00:00+02:00' })).status).toBe(422);
    expect((await api.patch(gallery, { expiresAt: 'tomorrow' })).status).toBe(422);
    expect(await outbox(gallery)).toHaveLength(0);

    const at = future();
    const res = await readJson<GalleryDetail>(await api.patch(gallery, { expiresAt: at }));
    expect(res.data!.expiresAt).toBe(at);
    let rows = await outbox(gallery);
    expect(rows.map((r) => r.event_name)).toEqual(['gallery.access_changed']);
    expect(rows[0]!.payload).toMatchObject({ type: 'gallery.access_changed', galleryId: gallery });

    // Same value again: no change, no new sync. Title-only edits never sync.
    await api.patch(gallery, { expiresAt: at, title: 'New' });
    expect(await outbox(gallery)).toHaveLength(1);

    // J4: an expired gallery is revived by extending; removing expiry also syncs.
    await sql`update public.galleries set status = 'published', published_at = now(),
              expires_at = now() - interval '1 minute' where id = ${gallery}`;
    expect((await readJson<GalleryDetail>(await api.get(gallery))).data!.accessState).toBe(
      'expired',
    );
    const revived = await readJson<GalleryDetail>(await api.patch(gallery, { expiresAt: null }));
    expect(revived.data!.accessState).toBe('published');
    rows = await outbox(gallery);
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------

describe('POST /api/v1/galleries/{id}/publish', () => {
  it('publishes immediately regardless of item readiness; published_at set once', async () => {
    const { gallery } = await ownedWithUser();
    await addMedia(gallery, 'a0', 'uploading');
    await addMedia(gallery, 'a1', 'processing');
    const before = await galleryRow(gallery);

    const first = await api.publish(gallery);
    expect(first.status).toBe(201);
    const { data } = await readJson<PublishGalleryResponse>(first);
    expect(data).toMatchObject({
      slug: before.slug,
      shareUrl: `https://lumra.test/g/${before.slug}`,
      alreadyPublished: false,
      hasPassword: false,
      expiresAt: null,
    });
    const row = await galleryRow(gallery);
    expect(row.status).toBe('published');
    expect(row.published_at!.toISOString()).toBe(data!.publishedAt);
    expect((await outbox(gallery)).map((r) => r.event_name)).toEqual(['gallery.access_changed']);

    // Replay (even with settings) is idempotent: same slug and published_at, nothing changed.
    const replay = await api.publish(gallery, { password: 'ignored-1' });
    expect(replay.status).toBe(200);
    const again = await readJson<PublishGalleryResponse>(replay);
    expect(again.data).toMatchObject({
      slug: before.slug,
      publishedAt: data!.publishedAt,
      alreadyPublished: true,
      hasPassword: false,
    });
    const after = await galleryRow(gallery);
    expect(after.published_at!.toISOString()).toBe(data!.publishedAt);
    expect(after.password_hash).toBeNull();
    expect(await outbox(gallery)).toHaveLength(1);
  });

  it('concurrent publishes commit once', async () => {
    const { gallery } = await ownedWithUser();
    const results = await Promise.all(Array.from({ length: 4 }, () => api.publish(gallery)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    const bodies = await Promise.all(results.map((r) => readJson<PublishGalleryResponse>(r)));
    expect(new Set(bodies.map((b) => b.data!.publishedAt)).size).toBe(1);
    expect(await outbox(gallery)).toHaveLength(1);
  });

  it('applies optional expiry and password (hashed, never plaintext)', async () => {
    const { gallery } = await ownedWithUser();
    const at = future();
    const res = await api.publish(gallery, { expiresAt: at, password: 'open sesame' });
    expect(res.status).toBe(201);
    const { data } = await readJson<PublishGalleryResponse>(res);
    expect(data).toMatchObject({ expiresAt: at, hasPassword: true });
    const row = await galleryRow(gallery);
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain('open sesame');
    expect(await verifyGalleryPassword('open sesame', row.password_hash!)).toBe(true);
  });

  it('validates expiry and password', async () => {
    const { gallery } = await ownedWithUser();
    expect((await api.publish(gallery, { expiresAt: '2001-01-01T00:00:00Z' })).status).toBe(422);
    expect((await api.publish(gallery, { password: 'abc' })).status).toBe(422);
    expect((await galleryRow(gallery)).status).toBe('draft');
  });
});

// ---------------------------------------------------------------------------------------------

describe('PUT /api/v1/galleries/{id}/password', () => {
  it('set / change / remove bump access_version and enqueue access sync', async () => {
    const { gallery } = await ownedWithUser();
    await api.publish(gallery);
    const v0 = (await galleryRow(gallery)).access_version;

    const set = await readJson<SetGalleryPasswordResponse>(
      await api.password(gallery, { password: 'first-pass' }),
    );
    expect(set.data).toEqual({ hasPassword: true, accessVersion: v0 + 1 });
    const h1 = (await galleryRow(gallery)).password_hash!;
    expect(await verifyGalleryPassword('first-pass', h1)).toBe(true);

    const changed = await readJson<SetGalleryPasswordResponse>(
      await api.password(gallery, { password: 'second-pass' }),
    );
    expect(changed.data!.accessVersion).toBe(v0 + 2);
    const h2 = (await galleryRow(gallery)).password_hash!;
    expect(await verifyGalleryPassword('first-pass', h2)).toBe(false);

    const removed = await readJson<SetGalleryPasswordResponse>(
      await api.password(gallery, { password: null }),
    );
    expect(removed.data).toEqual({ hasPassword: false, accessVersion: v0 + 3 });
    expect((await galleryRow(gallery)).password_hash).toBeNull();

    // publish + 3 password changes = 4 access syncs, each with a unique dedupe key.
    const rows = await outbox(gallery);
    expect(rows.map((r) => r.event_name)).toEqual(Array(4).fill('gallery.access_changed'));
    expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(4);

    // Removing a password that isn't set is a no-op.
    const noop = await readJson<SetGalleryPasswordResponse>(
      await api.password(gallery, { password: null }),
    );
    expect(noop.data!.accessVersion).toBe(v0 + 3);
    expect(await outbox(gallery)).toHaveLength(4);
  });

  it('validates the body', async () => {
    const { gallery } = await ownedWithUser();
    expect((await api.password(gallery, {})).status).toBe(422);
    expect((await api.password(gallery, { password: 'abc' })).status).toBe(422);
    expect((await api.password(gallery, { password: 'x'.repeat(201) })).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------------------------

describe('DELETE /api/v1/galleries/{id}', () => {
  it('is immediate: deleted + access bump + outbox rows before the response returns', async () => {
    const { gallery } = await ownedWithUser();
    await addMedia(gallery, 'a0', 'uploading');
    await api.publish(gallery);
    const v = (await galleryRow(gallery)).access_version;

    const res = await api.del(gallery);
    expect(res.status).toBe(200);
    const { data } = await readJson<DeleteGalleryResponse>(res);
    expect(data).toMatchObject({ id: gallery, status: 'deleted' });

    const row = await galleryRow(gallery);
    expect(row.status).toBe('deleted');
    expect(row.deleted_at).not.toBeNull();
    expect(row.access_version).toBe(v + 1);
    const events = (await outbox(gallery)).map((r) => r.event_name);
    expect(events.filter((e) => e === 'gallery.delete')).toHaveLength(1);
    expect(events.filter((e) => e === 'gallery.access_changed')).toHaveLength(2);
    const del = (await outbox(gallery)).find((r) => r.event_name === 'gallery.delete')!;
    expect(del.dedupe_key).toBe(`gallery.delete:${gallery}`);
    expect(del.payload).toMatchObject({ type: 'gallery.delete', galleryId: gallery });

    // Gone for the owner too; a second delete is concealed.
    expect((await api.get(gallery)).status).toBe(404);
    expect((await api.del(gallery)).status).toBe(404);
  });

  it('frees a Free-plan gallery slot immediately', async () => {
    const user = await createUser('free');
    const a = await createOwnedGallery(user);
    await createOwnedGallery(user);
    signInAs(user);
    const { POST: create } = await import('@/app/api/v1/galleries/route');
    expect((await create(jsonRequest('/api/v1/galleries', { body: {} }), {})).status).toBe(403);
    await api.del(a);
    expect((await create(jsonRequest('/api/v1/galleries', { body: {} }), {})).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------

describe('PATCH /api/v1/galleries/{id}/media/order', () => {
  it('applies the order with minimal updates and bumps content_version', async () => {
    const { gallery } = await ownedWithUser();
    const ids = [
      await addMedia(gallery, 'a0'),
      await addMedia(gallery, 'a1'),
      await addMedia(gallery, 'a2'),
      await addMedia(gallery, 'a3'),
    ];
    const v = (await galleryRow(gallery)).content_version;
    const target = [ids[3]!, ids[0]!, ids[1]!, ids[2]!];
    const res = await api.order(gallery, target);
    expect(res.status).toBe(200);
    const { data } = await readJson<ReorderMediaResponse>(res);
    expect(data).toEqual({ contentVersion: v + 1, updated: 1, rebalanced: false });
    expect(await orderOf(gallery)).toEqual(target);

    // Same order again: no writes, revision unchanged.
    const same = await readJson<ReorderMediaResponse>(await api.order(gallery, target));
    expect(same.data).toEqual({ contentVersion: v + 1, updated: 0, rebalanced: false });

    // Detail reflects it (and is what pagination would walk).
    const detail = await readJson<GalleryDetail>(await api.get(gallery));
    expect(detail.data!.items.map((i) => i.id)).toEqual(target);
  });

  it('rebalances atomically when keys grow too long', async () => {
    const { gallery } = await ownedWithUser();
    const tight = 'a0' + 'V'.repeat(29);
    const a = await addMedia(gallery, tight);
    const b = await addMedia(gallery, `${tight}1`);
    const c = await addMedia(gallery, 'a1');
    // Moving c between a and b needs a key longer than the 32-char limit.
    const res = await readJson<ReorderMediaResponse>(await api.order(gallery, [a, c, b]));
    expect(res.data!.rebalanced).toBe(true);
    expect(await orderOf(gallery)).toEqual([a, c, b]);
    const keys = await sql<{ sort_key: string }[]>`
      select sort_key from public.media where gallery_id = ${gallery}`;
    expect(keys.every((k) => k.sort_key.length <= 32)).toBe(true);
  });

  it('stale lists (missing, extra, duplicate, foreign ids) are a retryable 409', async () => {
    const { user, gallery } = await ownedWithUser();
    const a = await addMedia(gallery, 'a0');
    const b = await addMedia(gallery, 'a1');
    const foreign = await addMedia(await createOwnedGallery(user), 'a0');
    for (const ids of [[a], [a, b, foreign], [a, a], [b, foreign]]) {
      const res = await api.order(gallery, ids);
      expect(res.status).toBe(409);
      const body = await readJson(res);
      expect(body.error).toMatchObject({ code: 'conflict', retryable: true });
    }
    expect(await orderOf(gallery)).toEqual([a, b]);
    expect((await api.order(gallery, [])).status).toBe(422);
  });

  it('concurrent reorders serialise: the result is exactly one submitted order, keys unique', async () => {
    const { gallery } = await ownedWithUser();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await addMedia(gallery, `a${i.toString(36)}`));
    const orders = [
      [...ids].reverse(),
      [...ids.slice(6), ...ids.slice(0, 6)],
      [ids[11]!, ...ids.slice(0, 11)],
      [...ids.slice(1), ids[0]!],
    ];
    const results = await Promise.all(orders.map((o) => api.order(gallery, o)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const final = await orderOf(gallery);
    expect(orders.some((o) => o.join() === final.join())).toBe(true);
    const keys = await sql<{ sort_key: string }[]>`
      select sort_key from public.media where gallery_id = ${gallery} and deleted_at is null`;
    expect(new Set(keys.map((k) => k.sort_key)).size).toBe(ids.length);
    const versions = await Promise.all(
      results.map(async (r) => (await readJson<ReorderMediaResponse>(r)).data!.contentVersion),
    );
    expect(new Set(versions).size).toBe(versions.length);
  });
});

// ---------------------------------------------------------------------------------------------

describe('DELETE /api/v1/galleries/{id}/media/{mediaId}', () => {
  it('marks deleting, enqueues cleanup, clears the cover and bumps content_version', async () => {
    const { gallery } = await ownedWithUser();
    const a = await addMedia(gallery, 'a0');
    const b = await addMedia(gallery, 'a1');
    await api.patch(gallery, { coverMediaId: a });
    const v = (await galleryRow(gallery)).content_version;

    const res = await api.delMedia(gallery, a);
    expect(res.status).toBe(200);
    const { data } = await readJson<DeleteMediaResponse>(res);
    expect(data).toEqual({
      mediaId: a,
      status: 'deleting',
      contentVersion: v + 1,
      coverMediaId: null,
    });
    const [row] = await sql<{ status: string; deleted_at: Date | null }[]>`
      select status, deleted_at from public.media where id = ${a}`;
    expect(row!.status).toBe('deleting');
    expect(row!.deleted_at).not.toBeNull();
    const events = await outbox(a);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_name: 'media.delete',
      dedupe_key: `media.delete:${a}`,
      payload: { type: 'media.delete', mediaId: a },
    });
    expect(await orderOf(gallery)).toEqual([b]);
    const detail = await readJson<GalleryDetail>(await api.get(gallery));
    expect(detail.data!.itemCount).toBe(1);

    // Deleting again (or a non-cover item keeps the cover).
    expect((await api.delMedia(gallery, a)).status).toBe(404);
    await api.patch(gallery, { coverMediaId: b });
    const c = await addMedia(gallery, 'a2');
    const other = await readJson<DeleteMediaResponse>(await api.delMedia(gallery, c));
    expect(other.data!.coverMediaId).toBe(b);
  });

  it('releases a pending upload reservation', async () => {
    const { gallery } = await ownedWithUser();
    const m = await addMedia(gallery, 'a0', 'uploading');
    const [session] = await sql<{ id: string }[]>`
      insert into public.upload_sessions (gallery_id, media_id, part_size, reserved_bytes, expires_at, idempotency_key)
      values (${gallery}, ${m}, 8388608, 1000, now() + interval '1 day', ${randomUUID()}) returning id`;
    await sql`update public.media set upload_session_id = ${session!.id} where id = ${m}`;
    expect((await api.delMedia(gallery, m)).status).toBe(200);
    const [row] = await sql<{ status: string }[]>`
      select status from public.upload_sessions where id = ${session!.id}`;
    expect(row!.status).toBe('aborted');
  });

  it('404 for media of another gallery and malformed ids', async () => {
    const { user, gallery } = await ownedWithUser();
    const foreign = await addMedia(await createOwnedGallery(user), 'a0');
    expect((await api.delMedia(gallery, foreign)).status).toBe(404);
    expect((await api.delMedia(gallery, 'nope')).status).toBe(404);
    const [row] = await sql<{ status: string }[]>`
      select status from public.media where id = ${foreign}`;
    expect(row!.status).toBe('ready');
  });
});
