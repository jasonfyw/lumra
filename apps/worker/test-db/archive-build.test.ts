/**
 * `archive.build` against local Supabase (T24): the real archive repository drives the handler
 * end to end (claim → stream parts → record → ready), with in-memory R2 buckets.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createArchiveRepository, createSqlClient, pgArray } from '@lumra/db';
import { archivePartKey, crc32 } from '@lumra/media';
import {
  handleArchiveBuild,
  type ArchivesStore,
  type MultipartUpload,
} from '../src/handlers/archive-build';
import { silentLogger } from '../src/log';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const sql = createSqlClient(DATABASE_URL, { max: 4 });

let ownerId: string;
const galleries: string[] = [];

class MemoryArchives implements ArchivesStore {
  objects = new Map<string, Uint8Array>();
  async createMultipartUpload(key: string): Promise<MultipartUpload> {
    return this.resumeMultipartUpload(key, randomUUID());
  }
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    const parts = new Map<number, Uint8Array>();
    return {
      uploadId,
      uploadPart: async (n, v) => {
        parts.set(n, v.slice());
        return { partNumber: n, etag: `e${n}` };
      },
      complete: async (list) => {
        const chunks = list.map((p) => parts.get(p.partNumber)!);
        const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        this.objects.set(key, out);
      },
      abort: async () => undefined,
    };
  }
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
  await sql`delete from auth.users where id = ${ownerId}`.catch(() => {});
  await sql.end();
});

async function seed(items: number) {
  const [g] = await sql<{ id: string }[]>`
    insert into public.galleries (owner_id, slug, status, published_at, content_version)
    values (${ownerId}, ${randomUUID().replaceAll('-', '').slice(0, 20)}, 'published', now(), 2)
    returning id`;
  const galleryId = g!.id;
  galleries.push(galleryId);
  const originals = new Map<string, Uint8Array>();
  const entries = [];
  for (let i = 0; i < items; i++) {
    const id = randomUUID();
    const key = `originals/owner-123456/${galleryId}/${id}/source`;
    const bytes = new Uint8Array(5_000 + i).map((_, j) => (j * 13 + i) & 0xff);
    originals.set(key, bytes);
    await sql`
      insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key, status, width, height, ready_at)
      values (${id}, ${galleryId}, ${key}, ${`IMG_${i}.jpg`}, 'image/jpeg', ${bytes.length},
              ${`a${i}`}, 'ready', 10, 10, now())`;
    entries.push({ mediaId: id, name: `IMG_${i}.jpg`, bytes: bytes.length });
  }
  const jobId = randomUUID();
  const total = entries.reduce((s, e) => s + e.bytes, 0);
  await sql`
    insert into public.archive_jobs (id, gallery_id, requested_by_session_hash, content_version,
      access_version, source_fingerprint, status, parts_expected, item_count, total_bytes)
    values (${jobId}, ${galleryId}, 'ip:test', 2, 1, ${'b'.repeat(64)}, 'queued', 2, ${items}, ${total})`;
  const half = Math.ceil(items / 2);
  for (const [n, slice] of [entries.slice(0, half), entries.slice(half)].entries()) {
    await sql`
      insert into public.archive_parts (job_id, part_no, object_key, entries, item_count, source_bytes)
      values (${jobId}, ${n + 1}, ${archivePartKey(galleryId, jobId, n + 1)}, ${sql.json(slice)},
              ${slice.length}, ${slice.reduce((s, e) => s + e.bytes, 0)})`;
  }
  const store = {
    async get(key: string) {
      const bytes = originals.get(key);
      if (!bytes) return null;
      return { size: bytes.length, body: new Blob([bytes]).stream() };
    },
  };
  return { galleryId, jobId, store, originals };
}

describe('archive.build (db)', () => {
  it('builds every part and marks the job ready with sizes and progress', async () => {
    const { jobId, store, galleryId } = await seed(5);
    const archives = new MemoryArchives();
    const outcome = await handleArchiveBuild(jobId, {
      repo: createArchiveRepository(sql),
      originals: store,
      archives,
      log: silentLogger,
      attempt: 1,
      crc32,
      partBytes: 4096,
    });
    expect(outcome).toBe('ready');
    const [job] = await sql<
      { status: string; progress_pct: number; expires_at: Date; lease_until: Date | null }[]
    >`select status, progress_pct, expires_at, lease_until from public.archive_jobs where id = ${jobId}`;
    expect(job!.status).toBe('ready');
    expect(job!.progress_pct).toBe(100);
    expect(job!.lease_until).toBeNull();
    expect(job!.expires_at.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const parts = await sql<{ part_no: number; byte_size: string; completed_at: Date | null }[]>`
      select part_no, byte_size::text, completed_at from public.archive_parts
      where job_id = ${jobId} order by part_no`;
    for (const p of parts) {
      const zip = archives.objects.get(archivePartKey(galleryId, jobId, p.part_no))!;
      expect(Number(p.byte_size)).toBe(zip.length);
      expect(p.completed_at).not.toBeNull();
    }
    // Redelivery is a no-op.
    expect(
      await handleArchiveBuild(jobId, {
        repo: createArchiveRepository(sql),
        originals: store,
        archives,
        log: silentLogger,
        attempt: 2,
      }),
    ).toBe('not_buildable');
  });

  it('fails the job when the gallery is reordered before the build', async () => {
    const { jobId, store, galleryId } = await seed(2);
    await sql`update public.galleries set content_version = 3 where id = ${galleryId}`;
    const outcome = await handleArchiveBuild(jobId, {
      repo: createArchiveRepository(sql),
      originals: store,
      archives: new MemoryArchives(),
      log: silentLogger,
      attempt: 1,
      crc32,
    });
    expect(outcome).toBe('failed:content_changed');
    const [job] = await sql<{ status: string; failure_code: string }[]>`
      select status, failure_code from public.archive_jobs where id = ${jobId}`;
    expect(job).toEqual({ status: 'failed', failure_code: 'content_changed' });
  });
});
