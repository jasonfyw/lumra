/**
 * Physical deletion (T13, FR-G06) against local Supabase: the real deletion repository with
 * seeded drift — media stuck in `deleting` for days, a deleted gallery whose purge never ran,
 * archive jobs — purged into fake R2 buckets, run twice to prove idempotency.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeletionRepository, createSqlClient, pgArray } from '@lumra/db';
import { archivePartKey, derivativeKey } from '@lumra/media';
import {
  purgeGallery,
  purgeMedia,
  sweepDeletions,
  type ListablePurgeBucket,
} from '../src/handlers/purge';
import { silentLogger } from '../src/log';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
// Production (Hyperdrive) client settings so the array parameters are exercised as deployed.
const sql = createSqlClient(DATABASE_URL, { max: 4, prepare: true, statementTimeoutMs: 0 });

let ownerId: string;
const galleries: string[] = [];

class FakeBucket implements ListablePurgeBucket {
  readonly objects = new Set<string>();
  async delete(keys: string[]) {
    for (const k of keys) this.objects.delete(k);
  }
  async list({ prefix }: { prefix: string }) {
    const objects = [...this.objects].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
    return { objects, truncated: false };
  }
}

function buckets() {
  return { originals: new FakeBucket(), derivatives: new FakeBucket(), archives: new FakeBucket() };
}

beforeAll(async () => {
  ownerId = randomUUID();
  await sql`
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
    values (${ownerId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`${ownerId}@example.test`}, '{}', '{}')`;
});

afterAll(async () => {
  if (galleries.length)
    await sql`delete from public.galleries where id = any(${pgArray(galleries)}::uuid[])`;
  await sql`delete from public.billing_accounts where user_id = ${ownerId}`.catch(() => {});
  await sql`delete from public.profiles where id = ${ownerId}`.catch(() => {});
  await sql`delete from auth.users where id = ${ownerId}`.catch(() => {});
  await sql.end();
});

async function seedGallery(deletedAgo: string | null = null) {
  const [g] = await sql<{ id: string }[]>`
    insert into public.galleries (owner_id, slug, status, deleted_at)
    values (${ownerId}, ${randomUUID().replaceAll('-', '').slice(0, 20)},
            ${deletedAgo ? 'deleted' : 'draft'},
            ${deletedAgo ? sql`now() - ${deletedAgo}::interval` : null})
    returning id`;
  galleries.push(g!.id);
  return g!.id;
}

async function seedMedia(
  galleryId: string,
  b: ReturnType<typeof buckets>,
  status: string,
  deletedAgo: string | null,
) {
  const id = randomUUID();
  const originalKey = `originals/owner-123456/${galleryId}/${id}/source`;
  await sql`
    insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key,
                              status, ready_at, deleted_at)
    values (${id}, ${galleryId}, ${originalKey}, 'IMG_1.JPG', 'image/jpeg', 1000, ${id.slice(0, 8)},
            ${status}, ${status === 'ready' ? sql`now()` : null},
            ${deletedAgo ? sql`now() - ${deletedAgo}::interval` : null})`;
  b.originals.objects.add(originalKey);
  for (const [variant, hash] of [
    ['thumb', 'w320q80'],
    ['display', 'w1600q82'],
  ] as const) {
    const key = derivativeKey(galleryId, id, hash);
    await sql`
      insert into public.media_variants (media_id, variant, object_key, mime, width, height, byte_size)
      values (${id}, ${variant}, ${key}, 'image/webp', 320, 240, 100)`;
    b.derivatives.objects.add(key);
  }
  return id;
}

const statusOf = async (id: string) =>
  (
    await sql<{ status: string; deleted: boolean }[]>`
    select status, deleted_at is not null as deleted from public.media where id = ${id}`
  )[0];

describe('physical deletion (db)', () => {
  it('media.delete purges objects and marks the row deleted, idempotently', async () => {
    const b = buckets();
    const deps = { repo: createDeletionRepository(sql), ...b, log: silentLogger };
    const g = await seedGallery();
    const id = await seedMedia(g, b, 'deleting', '1 minute');
    const live = await seedMedia(g, b, 'ready', null);

    expect(await purgeMedia([id], deps)).toMatchObject({ purged: 1, objectKeys: 3 });
    expect(await statusOf(id)).toEqual({ status: 'deleted', deleted: true });
    expect(await purgeMedia([id], deps)).toMatchObject({ purged: 0, alreadyPurged: 1 });

    // Live media are refused even if a bogus message names them.
    expect(await purgeMedia([live], deps)).toMatchObject({ purged: 0, live: 1 });
    expect(await statusOf(live)).toEqual({ status: 'ready', deleted: false });
    expect(b.originals.objects.size).toBe(1);
    expect(b.derivatives.objects.size).toBe(2);
    // Variant rows are kept (history); the purge only removes objects.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.media_variants where media_id = ${id}`;
    expect(n).toBe(2);
  });

  it('gallery.delete purges all media, archive objects and archive jobs', async () => {
    const b = buckets();
    const deps = { repo: createDeletionRepository(sql), ...b, log: silentLogger };
    const g = await seedGallery('1 minute');
    const ids = [
      await seedMedia(g, b, 'ready', null),
      await seedMedia(g, b, 'deleting', '1 minute'),
      await seedMedia(g, b, 'failed', null),
    ];
    const [job] = await sql<{ id: string }[]>`
      insert into public.archive_jobs (gallery_id, requested_by_session_hash, content_version, status)
      values (${g}, 'hash', 1, 'ready') returning id`;
    b.archives.objects.add(archivePartKey(g, job!.id, 1));

    const result = await purgeGallery(g, deps, { budgetMs: 30_000, batchSize: 2 });
    expect(result).toMatchObject({ outcome: 'purged', archiveObjects: 1, archiveJobs: 1 });
    expect(result.media.purged).toBe(3);
    for (const id of ids) expect(await statusOf(id)).toEqual({ status: 'deleted', deleted: true });
    expect(b.originals.objects.size + b.derivatives.objects.size + b.archives.objects.size).toBe(0);
    const [a] = await sql<{ status: string }[]>`
      select status from public.archive_jobs where id = ${job!.id}`;
    expect(a!.status).toBe('deleted');

    const again = await purgeGallery(g, deps, { budgetMs: 30_000 });
    expect(again).toMatchObject({ outcome: 'purged', archiveJobs: 0 });
    expect(again.media.purged).toBe(0);
  });

  it('the sweep picks up stuck deletions older than an hour and nothing else', async () => {
    const b = buckets();
    const deps = { repo: createDeletionRepository(sql), ...b, log: silentLogger };
    const live = await seedGallery();
    const stuck = await seedMedia(live, b, 'deleting', '3 days');
    const fresh = await seedMedia(live, b, 'deleting', '5 minutes');
    const ready = await seedMedia(live, b, 'ready', null);
    const deletedGallery = await seedGallery('2 hours');
    const orphaned = await seedMedia(deletedGallery, b, 'ready', null);

    const result = await sweepDeletions(deps, { budgetMs: 30_000 });
    expect(result.galleriesFailed + result.mediaBatchesFailed).toBe(0);
    expect(await statusOf(stuck)).toEqual({ status: 'deleted', deleted: true });
    expect(await statusOf(orphaned)).toEqual({ status: 'deleted', deleted: true });
    expect((await statusOf(fresh))!.status).toBe('deleting');
    expect((await statusOf(ready))!.status).toBe('ready');

    const repo = createDeletionRepository(sql);
    const cutoff = new Date(Date.now() - 3_600_000);
    expect(await repo.listStuckMedia(cutoff, 1000)).not.toContain(stuck);
    expect(await repo.listStuckGalleries(cutoff, 1000)).not.toContain(deletedGallery);
  });
});
