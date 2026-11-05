/**
 * T12 integration tests: media pipeline repository + outbox relay claims against local Supabase.
 * Rows are committed (the repositories open their own transactions), so every fixture is created
 * with unique ids and removed in afterAll.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMediaPipelineRepository, createOutboxRepository } from '../src';
import { connect, createUser, slug, type Sql } from './helpers';

let sql: Sql;
let ownerId: string;
const galleries: string[] = [];
const outboxIds: string[] = [];

beforeAll(async () => {
  sql = connect(10);
  ownerId = await createUser(sql);
});

afterAll(async () => {
  if (galleries.length)
    await sql`delete from public.galleries where id = any(${galleries}::uuid[])`;
  if (outboxIds.length)
    await sql`delete from public.job_outbox where id = any(${outboxIds}::uuid[])`;
  await sql`delete from public.billing_accounts where user_id = ${ownerId}`.catch(() => {});
  await sql`delete from public.profiles where id = ${ownerId}`.catch(() => {});
  await sql`delete from auth.users where id = ${ownerId}`.catch(() => {});
  await sql.end();
});

async function seedMedia(status = 'uploaded'): Promise<{ galleryId: string; mediaId: string }> {
  const [g] = await sql<{ id: string }[]>`
    insert into public.galleries (owner_id, slug) values (${ownerId}, ${slug()}) returning id`;
  galleries.push(g!.id);
  const mediaId = randomUUID();
  await sql`
    insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key, status)
    values (${mediaId}, ${g!.id}, ${`originals/owner-123456/${g!.id}/${mediaId}/source`}, 'IMG_1.HEIC',
            'image/jpeg', 1234, 'a0', ${status})`;
  return { galleryId: g!.id, mediaId };
}

const variant = (galleryId: string, mediaId: string, name: string, width: number) => ({
  variant: name,
  objectKey: `derivatives/${galleryId}/${mediaId}/${name}abc1234.webp`,
  mime: 'image/webp',
  width,
  height: Math.round(width * 0.75),
  byteSize: width * 10,
});

describe('media pipeline repository', () => {
  it('uploaded → processing → ready with variants, dimensions and corrected MIME in one commit', async () => {
    const repo = createMediaPipelineRepository(sql);
    const { galleryId, mediaId } = await seedMedia();

    expect(await repo.getForProcessing(mediaId)).toMatchObject({
      galleryId,
      status: 'uploaded',
      mime: 'image/jpeg',
      byteSize: 1234,
      deleted: false,
    });
    expect(await repo.markProcessing(mediaId)).toBe(true);
    expect(await repo.markProcessing(mediaId)).toBe(true); // redelivery heartbeat

    const result = await repo.complete({
      mediaId,
      mime: 'image/heic',
      width: 3024,
      height: 4032,
      orientation: 6,
      takenAt: '2024-05-06T05:08:09.000Z',
      variants: [
        variant(galleryId, mediaId, 'w320', 320),
        variant(galleryId, mediaId, 'w640', 640),
      ],
    });
    expect(result).toEqual({ status: 'committed', staleObjectKeys: [] });

    const [m] =
      await sql`select status, mime, width, height, orientation, taken_at, ready_at, failure_code
                          from public.media where id = ${mediaId}`;
    expect(m).toMatchObject({
      status: 'ready',
      mime: 'image/heic',
      width: 3024,
      height: 4032,
      orientation: 6,
    });
    expect(m!.ready_at).not.toBeNull();
    expect((m!.taken_at as Date).toISOString()).toBe('2024-05-06T05:08:09.000Z');
    const vs =
      await sql`select variant, ready_at from public.media_variants where media_id = ${mediaId} order by variant`;
    expect(vs.map((v) => v.variant)).toEqual(['w320', 'w640']);
    expect(vs.every((v) => v.ready_at !== null)).toBe(true);

    // Redelivery after ready: the guard refuses both the transition and a second commit.
    expect(await repo.markProcessing(mediaId)).toBe(false);
    expect(await repo.complete({ ...(await completion(galleryId, mediaId)) })).toEqual({
      status: 'discarded',
      reason: 'not_processing',
    });
  });

  it('writes nothing when the media is deleted after processing started', async () => {
    const repo = createMediaPipelineRepository(sql);
    const { galleryId, mediaId } = await seedMedia();
    await repo.markProcessing(mediaId);
    await sql`update public.media set status = 'deleting', deleted_at = now() where id = ${mediaId}`;

    expect(await repo.complete(await completion(galleryId, mediaId))).toEqual({
      status: 'discarded',
      reason: 'deleted',
    });
    const [m] = await sql`select status, width from public.media where id = ${mediaId}`;
    expect(m).toMatchObject({ status: 'deleting', width: null });
    expect(await sql`select 1 from public.media_variants where media_id = ${mediaId}`).toHaveLength(
      0,
    );
    expect(await repo.markFailed(mediaId, 'malformed')).toBe(false);
  });

  it('writes nothing when the gallery is deleted mid-processing, even if the delete races the commit', async () => {
    const repo = createMediaPipelineRepository(sql);
    const { galleryId, mediaId } = await seedMedia();
    await repo.markProcessing(mediaId);

    // A gallery delete that holds its row lock while complete() runs: complete() blocks on the
    // share lock, then observes deleted_at once the delete commits.
    const deleter = sql.begin(async (tx) => {
      await tx`update public.galleries set status = 'deleted', deleted_at = now() where id = ${galleryId}`;
      await new Promise((r) => setTimeout(r, 300));
    });
    await new Promise((r) => setTimeout(r, 50));
    const result = await repo.complete(await completion(galleryId, mediaId));
    await deleter;
    expect(result).toEqual({ status: 'discarded', reason: 'deleted' });
    expect(await sql`select 1 from public.media_variants where media_id = ${mediaId}`).toHaveLength(
      0,
    );
    expect((await repo.getForProcessing(mediaId))?.deleted).toBe(true);
    expect(await repo.markProcessing(mediaId)).toBe(false);
  });

  it('replaces variants from an older pipeline and reports their stale object keys', async () => {
    const repo = createMediaPipelineRepository(sql);
    const { galleryId, mediaId } = await seedMedia('processing');
    const old = {
      ...variant(galleryId, mediaId, 'w320', 320),
      objectKey: `derivatives/${galleryId}/${mediaId}/w320old0001.webp`,
    };
    await sql`insert into public.media_variants (media_id, variant, object_key, mime, width, height, byte_size)
              values (${mediaId}, 'w320', ${old.objectKey}, 'image/webp', 320, 240, 1),
                     (${mediaId}, 'w2048', ${`derivatives/${galleryId}/${mediaId}/w2048old001.webp`}, 'image/webp', 2048, 1536, 1)`;
    const result = await repo.complete(await completion(galleryId, mediaId));
    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      expect(result.staleObjectKeys.sort()).toEqual(
        [old.objectKey, `derivatives/${galleryId}/${mediaId}/w2048old001.webp`].sort(),
      );
    }
    const vs =
      await sql`select variant, object_key from public.media_variants where media_id = ${mediaId}`;
    expect(vs).toEqual([
      { variant: 'w320', object_key: variant(galleryId, mediaId, 'w320', 320).objectKey },
    ]);
  });

  it('marks failed with a failure code only from uploaded/processing', async () => {
    const repo = createMediaPipelineRepository(sql);
    const { mediaId } = await seedMedia();
    await repo.markProcessing(mediaId);
    expect(await repo.markFailed(mediaId, 'too_many_pixels')).toBe(true);
    const [m] = await sql`select status, failure_code from public.media where id = ${mediaId}`;
    expect(m).toEqual({ status: 'failed', failure_code: 'too_many_pixels' });
    expect(await repo.markProcessing(mediaId)).toBe(false);
  });

  it('rejects orientation values outside 1–8 (migration CHECK)', async () => {
    const { mediaId } = await seedMedia();
    await expect(
      sql`update public.media set orientation = 9 where id = ${mediaId}`,
    ).rejects.toMatchObject({
      code: '23514',
    });
  });
});

async function completion(galleryId: string, mediaId: string) {
  return {
    mediaId,
    mime: 'image/jpeg' as const,
    width: 400,
    height: 300,
    orientation: null,
    takenAt: null,
    variants: [variant(galleryId, mediaId, 'w320', 320)],
  };
}

describe('outbox relay repository', () => {
  const tag = randomUUID();

  async function seedOutbox(n: number): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
      insert into public.job_outbox (event_name, aggregate_id, payload, dedupe_key, available_at)
      select 'media.uploaded', gen_random_uuid(), jsonb_build_object('tag', ${tag}::text),
             ${randomUUID()} || ':' || i, now() - interval '1 hour'
      from generate_series(1, ${n}) as i
      returning id`;
    const ids = rows.map((r) => r.id);
    outboxIds.push(...ids);
    return ids;
  }

  /** Only rows from this test run (the shared local DB may contain other due rows). */
  async function claimMine(repo: ReturnType<typeof createOutboxRepository>, limit: number) {
    const claimed = await repo.claim(limit, 60);
    const mine = claimed.filter((r) => (r.payload as { tag?: string }).tag === tag);
    // Release foreign rows immediately so other test suites are unaffected.
    const foreign = claimed.filter((r) => !mine.includes(r)).map((r) => r.id);
    if (foreign.length)
      await sql`update public.job_outbox set available_at = now() where id = any(${foreign}::uuid[])`;
    return mine;
  }

  it('concurrent relays never claim the same row (FOR UPDATE SKIP LOCKED + lease)', async () => {
    const ids = await seedOutbox(60);
    const pools = Array.from({ length: 6 }, () => connect(2));
    const relays = pools.map((pool) => createOutboxRepository(pool));
    const claims = await Promise.all(relays.map((r) => claimMine(r, 15)));
    await Promise.all(pools.map((pool) => pool.end()));
    const all = claims.flat().map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((id) => ids.includes(id))).toBe(true);

    // Leased rows are invisible to later claims until the lease expires.
    const again = await claimMine(createOutboxRepository(sql), 100);
    expect(again.some((r) => all.includes(r.id))).toBe(false);
  });

  it('marks published rows processed and is idempotent; failures bump attempts and reschedule', async () => {
    const repo = createOutboxRepository(sql);
    const [a, b] = await seedOutbox(2);
    await repo.markPublished([a!]);
    await repo.markPublished([a!]);
    await repo.markFailed(b!, 'publish failed: queue down', 120);

    const rows = await sql`
      select id, processed_at, attempt_count, last_error, available_at > now() + interval '100 seconds' as later
      from public.job_outbox where id = any(${[a!, b!]}::uuid[])`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[a!]).toMatchObject({ attempt_count: 0, last_error: null });
    expect(byId[a!]!.processed_at).not.toBeNull();
    expect(byId[b!]).toMatchObject({
      processed_at: null,
      attempt_count: 1,
      last_error: 'publish failed: queue down',
      later: true,
    });

    // Processed and rescheduled rows are not claimable now.
    const claimed = await claimMine(repo, 100);
    expect(claimed.map((r) => r.id)).not.toContain(a);
    expect(claimed.map((r) => r.id)).not.toContain(b);
  });
});
