/**
 * T24 integration tests: archive build repository (lease, content-version guard, transitions),
 * the archive columns' constraints and RLS, and archive bytes in storage accrual. Everything
 * runs in rolled-back transactions.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createArchiveRepository, createBillingRepository } from '../src';
import {
  CHECK_VIOLATION,
  DENIED,
  actAs,
  connect,
  createGallery,
  createUser,
  expectSqlError,
  inRollback,
  type Sql,
  type Tx,
} from './helpers';

let sql: Sql;
beforeAll(() => {
  sql = connect();
});
afterAll(async () => {
  await sql.end();
});

const repoFor = (tx: Tx) => createArchiveRepository(tx as unknown as postgres.Sql);

async function fixture(tx: Tx, opts: { parts?: number } = {}) {
  const ownerId = await createUser(tx);
  const galleryId = await createGallery(tx, ownerId);
  await tx`update public.galleries set status = 'published', published_at = now(),
           content_version = 3 where id = ${galleryId}`;
  const mediaId = randomUUID();
  await tx`
    insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key, status, width, height, ready_at)
    values (${mediaId}, ${galleryId}, ${`originals/owner-1234/${galleryId}/${mediaId}/source`},
            'a.jpg', 'image/jpeg', 1000, 'a0', 'ready', 10, 10, now())`;
  const jobId = randomUUID();
  await tx`
    insert into public.archive_jobs (id, gallery_id, requested_by_session_hash, content_version,
      access_version, source_fingerprint, status, parts_expected, item_count, total_bytes)
    values (${jobId}, ${galleryId}, 'ip:test', 3, 1, ${'a'.repeat(64)}, 'queued',
            ${opts.parts ?? 1}, 1, 1000)`;
  const partIds: string[] = [];
  for (let n = 1; n <= (opts.parts ?? 1); n++) {
    const [row] = await tx<{ id: string }[]>`
      insert into public.archive_parts (job_id, part_no, object_key, entries, item_count, source_bytes)
      values (${jobId}, ${n}, ${`archives/${galleryId}/${jobId}/${n}.zip`},
              ${tx.json([{ mediaId, name: 'a.jpg', bytes: 1000 }])}, 1, 1000)
      returning id`;
    partIds.push(row!.id);
  }
  return { ownerId, galleryId, mediaId, jobId, partIds };
}

describe('archive repository', () => {
  it('claims queued jobs once (lease), resumes after the lease expires', async () => {
    await inRollback(sql, async (tx) => {
      const { jobId } = await fixture(tx);
      const repo = repoFor(tx);
      expect(await repo.claim(randomUUID(), 60_000)).toBe('missing');
      expect(await repo.claim(jobId, 60_000)).toBe('claimed');
      const [row] = await tx<{ status: string; started_at: Date | null }[]>`
        select status, started_at from public.archive_jobs where id = ${jobId}`;
      expect(row).toMatchObject({ status: 'running' });
      expect(row!.started_at).not.toBeNull();
      expect(await repo.claim(jobId, 60_000)).toBe('busy');
      await tx`update public.archive_jobs set lease_until = now() - interval '1 second'
               where id = ${jobId}`;
      expect(await repo.claim(jobId, 60_000)).toBe('claimed');
      await repo.releaseLease(jobId);
      expect(await repo.claim(jobId, 60_000)).toBe('claimed');
    });
  });

  it('reads parts with validated entries and gallery/media state', async () => {
    await inRollback(sql, async (tx) => {
      const { jobId, galleryId, mediaId } = await fixture(tx, { parts: 2 });
      const repo = repoFor(tx);
      const job = await repo.getJob(jobId);
      expect(job).toMatchObject({
        galleryId,
        contentVersion: 3,
        totalBytes: 1000,
        partsExpected: 2,
      });
      expect(job!.parts.map((p) => p.partNo)).toEqual([1, 2]);
      expect(job!.parts[0]!.entries).toEqual([{ mediaId, name: 'a.jpg', bytes: 1000 }]);
      expect(await repo.galleryState(galleryId)).toEqual({ contentVersion: 3, available: true });
      const [m] = await repo.media(galleryId, [mediaId, randomUUID()]);
      expect(m).toMatchObject({ id: mediaId, deliverable: true });
      await tx`update public.media set status = 'deleting', deleted_at = now() where id = ${mediaId}`;
      expect((await repo.media(galleryId, [mediaId]))[0]!.deliverable).toBe(false);
    });
  });

  it('records parts and marks ready only while the content version still matches', async () => {
    await inRollback(sql, async (tx) => {
      const { jobId, galleryId, partIds } = await fixture(tx, { parts: 2 });
      const repo = repoFor(tx);
      await repo.claim(jobId, 60_000);
      await repo.setPartUpload(partIds[0]!, 'upload-1');
      expect(
        await repo.completePart({ jobId, partId: partIds[0]!, byteSize: 1234, contentVersion: 3 }),
      ).toBe(true);
      const expires = new Date(Date.now() + 86_400_000);
      expect(await repo.markReady(jobId, expires, 3)).toBe(false); // part 2 missing
      await repo.setProgress(jobId, 40);
      await repo.setProgress(jobId, 20); // monotonic
      // A reorder bumps content_version: nothing more is recorded.
      await tx`update public.galleries set content_version = 4 where id = ${galleryId}`;
      expect(
        await repo.completePart({ jobId, partId: partIds[1]!, byteSize: 99, contentVersion: 3 }),
      ).toBe(false);
      await tx`update public.galleries set content_version = 3 where id = ${galleryId}`;
      expect(
        await repo.completePart({ jobId, partId: partIds[1]!, byteSize: 99, contentVersion: 3 }),
      ).toBe(true);
      expect(await repo.markReady(jobId, expires, 3)).toBe(true);
      const [job] = await tx<{ status: string; progress_pct: number; lease_until: Date | null }[]>`
        select status, progress_pct, lease_until from public.archive_jobs where id = ${jobId}`;
      expect(job).toEqual({ status: 'ready', progress_pct: 100, lease_until: null });
      const parts = await tx<{ byte_size: string; upload_id: string | null }[]>`
        select byte_size::text, upload_id from public.archive_parts where job_id = ${jobId}
        order by part_no`;
      expect(parts).toEqual([
        { byte_size: '1234', upload_id: null },
        { byte_size: '99', upload_id: null },
      ]);
      // Terminal: no further claims or failures.
      expect(await repo.claim(jobId, 60_000)).toBe('not_buildable');
      expect(await repo.markFailed(jobId, 'build_failed')).toBe(false);
    });
  });

  it('fails non-terminal jobs with a code and refuses a deleted gallery', async () => {
    await inRollback(sql, async (tx) => {
      const { jobId, galleryId, partIds } = await fixture(tx);
      const repo = repoFor(tx);
      await repo.claim(jobId, 60_000);
      await tx`update public.galleries set status = 'deleted', deleted_at = now() where id = ${galleryId}`;
      expect(await repo.galleryState(galleryId)).toEqual({ contentVersion: 3, available: false });
      expect(
        await repo.completePart({ jobId, partId: partIds[0]!, byteSize: 1, contentVersion: 3 }),
      ).toBe(false);
      expect(await repo.markFailed(jobId, 'gallery_unavailable')).toBe(true);
      const [job] = await tx<{ status: string; failure_code: string }[]>`
        select status, failure_code from public.archive_jobs where id = ${jobId}`;
      expect(job).toEqual({ status: 'failed', failure_code: 'gallery_unavailable' });
    });
  });
});

describe('archive columns', () => {
  it('enforce shapes and stay service-only', async () => {
    await inRollback(sql, async (tx) => {
      const { jobId } = await fixture(tx);
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) => sp`update public.archive_jobs set source_fingerprint = 'nope' where id = ${jobId}`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) => sp`update public.archive_parts set entries = '{}'::jsonb where job_id = ${jobId}`,
      );
      await expectSqlError(
        tx,
        CHECK_VIOLATION,
        (sp) => sp`update public.archive_jobs set total_bytes = -1 where id = ${jobId}`,
      );
      for (const role of ['anon', 'authenticated'] as const) {
        await expectSqlError(tx, DENIED, async (sp) => {
          await actAs(sp, role);
          await sp`select id from public.archive_jobs limit 1`;
        });
      }
    });
  });
});

describe('archives in billing', () => {
  it('count stored archive bytes in storage accrual and building jobs as reservations', async () => {
    await inRollback(sql, async (tx) => {
      const { ownerId, jobId, partIds } = await fixture(tx);
      const billing = createBillingRepository(tx as unknown as postgres.Sql);
      const at = new Date('2026-11-09T10:07:00Z');
      const mine = async () =>
        (await billing.storageAccrualCandidates(at, 10_000)).find((c) => c.accountId === ownerId);
      // 1000 original bytes (no derivative row in this fixture).
      expect((await mine())!.storedBytesNow).toBe(1000);
      expect(await billing.reservations.pending(ownerId)).toEqual([
        { kind: 'archive', bytes: 1000 },
      ]);
      await repoFor(tx).claim(jobId, 60_000);
      await repoFor(tx).completePart({
        jobId,
        partId: partIds[0]!,
        byteSize: 1_100,
        contentVersion: 3,
      });
      expect((await mine())!.storedBytesNow).toBe(2100);
      await tx`update public.archive_jobs set status = 'expired' where id = ${jobId}`;
      expect((await mine())!.storedBytesNow).toBe(1000);
    });
  });
});
