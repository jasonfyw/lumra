import { randomUUID } from 'node:crypto';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { accountUsageSummarySchema, type AccountUsageSummary } from '@lumra/contracts';
import type { Database } from '@lumra/db';
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

class Rollback extends Error {}

/** Runs `fn` in a transaction that is always rolled back (usage_ledger is append-only). */
async function inRollback<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await getDb()
    .transaction(async (tx) => {
      result = await fn(tx as unknown as Database);
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return result as T;
}

const ledgerRow = (db: Database, accountId: string, bytes: number, periodStart: string) =>
  db.execute(dsql`
    insert into public.usage_ledger (account_id, metric, quantity_micro_units, unit, source_id, event_time, period_start, rating_version)
    values (${accountId}::uuid, 'delivery_bytes', ${bytes}, 'bytes', ${randomUUID()}, now(),
            ${periodStart}::timestamptz, 1)`);

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
      delivery: { tracked: false, usedBytes: null },
    });

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

  it('reports delivery from the caller’s ledger rows for the current period only', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const now = new Date('2026-11-09T12:00:00Z');
    const summary = await inRollback(async (db) => {
      await ledgerRow(db, a, 1_500_000_000, '2026-11-01T00:00:00Z');
      await ledgerRow(db, a, 250_000_000, '2026-10-01T00:00:00Z'); // previous period
      await ledgerRow(db, b, 999_000_000, '2026-11-01T00:00:00Z'); // someone else
      return getAccountUsageSummary(db, { userId: a, email: null }, now);
    });
    expect(summary.period).toEqual({
      start: '2026-11-01T00:00:00.000Z',
      end: '2026-12-01T00:00:00.000Z',
    });
    expect(summary.delivery).toEqual({
      usedBytes: 1_500_000_000,
      limitBytes: 3_000_000_000,
      percentUsed: 50,
      tracked: true,
    });
  });
});
