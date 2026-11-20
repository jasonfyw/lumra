import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { accountUsageSummarySchema, type AccountUsageSummary } from '@lumra/contracts';
import { GET } from '../src/app/api/v1/billing/usage/route';
import { getDb } from '../src/lib/db';
import { getAccountUsageSummary } from '../src/server/account';
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

const get = () => GET(jsonRequest('/api/v1/billing/usage', { method: 'GET' }), {});

beforeEach(resetContext);
afterAll(cleanup);

/** Media rows straight to Postgres (byte_size is capped at 50 MB per original). */
async function addMedia(
  galleryId: string,
  bytes: number,
  opts: { status?: string; deleted?: boolean; variantBytes?: number } = {},
) {
  const id = randomUUID();
  const status = opts.status ?? 'ready';
  await sql`
    insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key, status, ready_at, deleted_at)
    values (${id}, ${galleryId}, ${`originals/u/${galleryId}/${id}/source`}, 'p.jpg', 'image/jpeg',
            ${bytes}, ${`a${id.slice(0, 8)}`}, ${status}, ${status === 'ready' ? new Date() : null},
            ${opts.deleted ? new Date() : null})`;
  if (opts.variantBytes) {
    await sql`
      insert into public.media_variants (media_id, variant, object_key, mime, width, height, byte_size)
      values (${id}, 'w320', ${`derivatives/${galleryId}/${id}/w320.webp`}, 'image/webp', 320, 240,
              ${opts.variantBytes})`;
  }
}

describe('authorization', () => {
  it('401 without a signed-in user', async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe('unauthenticated');
  });

  it('a guest cookie alone is not an account', async () => {
    useGuestCookie(await createGuestDraft());
    expect((await get()).status).toBe(401);
  });

  it('returns only the caller’s own usage, never another account’s', async () => {
    const [a, b] = [await createUser(), await createUser('pro')];
    await addMedia(await createOwnedGallery(a), 40_000_000, { variantBytes: 5_000_000 });
    await addMedia(await createOwnedGallery(b), 30_000_000, { variantBytes: 7_000_000 });

    signInAs(a);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const { data } = await readJson<AccountUsageSummary>(res);
    expect(accountUsageSummarySchema.parse(data)).toMatchObject({
      email: `${a}@example.test`,
      plan: 'free',
      billingStatus: 'free',
      storage: { usedBytes: 45_000_000, itemCount: 1, limitBytes: 1_000_000_000, percentUsed: 4 },
    });
    expect(data).not.toHaveProperty('delivery');

    signInAs(b);
    const other = (await readJson<AccountUsageSummary>(await get())).data!;
    expect(other).toMatchObject({
      plan: 'pro',
      storage: { usedBytes: 37_000_000, itemCount: 1, limitBytes: null, percentUsed: null },
    });
  });
});

describe('usage summary', () => {
  it('excludes deleted media, deleted galleries, guest drafts and unfinished uploads', async () => {
    const user = await createUser();
    const g = await createOwnedGallery(user);
    await addMedia(g, 10_000_000);
    await addMedia(g, 20_000_000, { status: 'processing' });
    await addMedia(g, 40_000_000, { status: 'uploading' });
    await addMedia(g, 8_000_000, { deleted: true, status: 'deleting', variantBytes: 1_000 });
    await addMedia(await createOwnedGallery(user, { deleted: true }), 16_000_000);
    await createGuestDraft();

    const summary = await getAccountUsageSummary(getDb(), { userId: user, email: null });
    expect(summary.storage).toMatchObject({ usedBytes: 30_000_000, itemCount: 2 });
    // Falls back to the profile email when the session carries none.
    expect(summary.email).toBe(`${user}@example.test`);
  });

  it('reports the current period and no delivery usage (ADR-008)', async () => {
    const a = await createUser();
    const now = new Date('2026-11-09T12:00:00Z');
    const summary = await getAccountUsageSummary(getDb(), { userId: a, email: null }, now);
    expect(summary.period).toEqual({
      start: '2026-11-01T00:00:00.000Z',
      end: '2026-12-01T00:00:00.000Z',
    });
    expect(summary).not.toHaveProperty('delivery');
    expect(summary.billing).not.toHaveProperty('deliveryPaused');
  });
});
