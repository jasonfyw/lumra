import { describe, expect, it } from 'vitest';
import type { ArchiveFailureCode, ArchivePartEntry } from '@lumra/contracts';
import type {
  ArchiveBuildJob,
  ArchiveClaim,
  ArchiveGalleryState,
  ArchiveMediaRow,
  ArchiveRepository,
} from '@lumra/db';
import { ARCHIVE_LIMITS } from '@lumra/config';
import type { ArchiveStatus } from '@lumra/domain';
import { archivePartKey, crc32 } from '@lumra/media';
import { archiveCrc32, nativeCrc32Available } from '../crc';
import { silentLogger } from '../log';
import {
  handleArchiveBuild,
  RetryLaterError,
  type ArchiveBuildDeps,
  type ArchivesStore,
  type MultipartUpload,
} from './archive-build';

const galleryId = '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f';
const jobId = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const keyOf = (mediaId: string) => `originals/owner-123456/${galleryId}/${mediaId}/source`;

function bytesFor(n: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + n * 7) & 0xff;
  return out;
}

/** In-memory job/parts/gallery with the same guarded semantics as the SQL repository. */
class FakeRepo implements ArchiveRepository {
  status: ArchiveStatus = 'queued';
  leaseHeld = false;
  failure: ArchiveFailureCode | null = null;
  gallery: ArchiveGalleryState = { contentVersion: 3, available: true };
  progress: number[] = [];
  uploadIds = new Map<string, string | null>();
  completed = new Set<string>();
  byteSizes = new Map<string, number>();
  undeliverable = new Set<string>();
  expiresAt: Date | null = null;
  calls: string[] = [];
  /** Runs before each completePart (e.g. to simulate a concurrent reorder). */
  beforeComplete?: () => void;

  constructor(readonly job: ArchiveBuildJob) {}

  async claim(): Promise<ArchiveClaim> {
    this.calls.push('claim');
    if (!['queued', 'running'].includes(this.status)) return 'not_buildable';
    if (this.leaseHeld) return 'busy';
    this.status = 'running';
    this.leaseHeld = true;
    return 'claimed';
  }
  async getJob() {
    return {
      ...this.job,
      status: this.status,
      parts: this.job.parts.map((p) => ({
        ...p,
        uploadId: this.uploadIds.get(p.id) ?? p.uploadId,
        completed: p.completed || this.completed.has(p.id),
      })),
    };
  }
  async galleryState() {
    return { ...this.gallery };
  }
  async media(_g: string, ids: readonly string[]): Promise<ArchiveMediaRow[]> {
    return ids.map((id) => ({
      id,
      originalKey: keyOf(id),
      deliverable: !this.undeliverable.has(id),
      createdAt: new Date('2026-10-12T14:03:22Z'),
    }));
  }
  async setPartUpload(partId: string, uploadId: string | null) {
    this.uploadIds.set(partId, uploadId);
  }
  async completePart(input: { partId: string; byteSize: number; contentVersion: number }) {
    this.beforeComplete?.();
    if (this.status !== 'running' || !this.gallery.available) return false;
    if (this.gallery.contentVersion !== input.contentVersion) return false;
    this.completed.add(input.partId);
    this.byteSizes.set(input.partId, input.byteSize);
    this.uploadIds.set(input.partId, null);
    return true;
  }
  async setProgress(_j: string, pct: number) {
    this.progress.push(pct);
  }
  async markReady(_j: string, expiresAt: Date, contentVersion: number) {
    if (this.status !== 'running' || this.gallery.contentVersion !== contentVersion) return false;
    if (this.job.parts.some((p) => !p.completed && !this.completed.has(p.id))) return false;
    this.status = 'ready';
    this.expiresAt = expiresAt;
    this.leaseHeld = false;
    return true;
  }
  async markFailed(_j: string, code: ArchiveFailureCode) {
    if (!['requested', 'queued', 'running'].includes(this.status)) return false;
    this.status = 'failed';
    this.failure = code;
    this.leaseHeld = false;
    return true;
  }
  async releaseLease() {
    this.leaseHeld = false;
  }
  async expireDue() {
    return [];
  }
  async failStalled() {
    return 0;
  }
}

class FakeArchives implements ArchivesStore {
  objects = new Map<string, Uint8Array>();
  aborted: string[] = [];
  partSizes = new Map<string, number[]>();
  failUploadPart = false;
  private seq = 0;

  async createMultipartUpload(key: string): Promise<MultipartUpload> {
    return this.upload(key, `upload-${++this.seq}`);
  }
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    return this.upload(key, uploadId);
  }
  private upload(key: string, uploadId: string): MultipartUpload {
    const parts = new Map<number, Uint8Array>();
    return {
      uploadId,
      uploadPart: async (n, value) => {
        if (this.failUploadPart) throw new Error('r2 unavailable');
        parts.set(n, value.slice());
        return { partNumber: n, etag: `etag-${n}` };
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
        this.partSizes.set(
          key,
          chunks.map((c) => c.length),
        );
      },
      abort: async () => {
        this.aborted.push(uploadId);
      },
    };
  }
}

function originalsFor(data: Map<string, Uint8Array>, missing = new Set<string>()) {
  return {
    async get(key: string) {
      const id = key.split('/')[3]!;
      if (missing.has(id)) return null;
      const bytes = data.get(id)!;
      let at = 0;
      return {
        size: bytes.length,
        body: new ReadableStream<Uint8Array>({
          pull(c) {
            if (at >= bytes.length) return c.close();
            c.enqueue(bytes.slice(at, at + 4096));
            at += 4096;
          },
        }),
      };
    },
  };
}

/** Minimal central-directory reader: entry names and stored bodies, CRCs verified. */
function readZip(zip: Uint8Array): { name: string; data: Uint8Array }[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const out: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    expect(v.getUint16(at + 10, true)).toBe(0); // stored
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    const dataAt = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = zip.subarray(dataAt, dataAt + size);
    expect(crc32(data)).toBe(crc);
    out.push({ name, data });
    at += 46 + nameLen + extraLen;
  }
  return out;
}

function fixture(partsOf: number[][], opts: { sizes?: number } = {}) {
  const data = new Map<string, Uint8Array>();
  let n = 0;
  const parts = partsOf.map((ids, i) => {
    const entries: ArchivePartEntry[] = ids.map((m) => {
      const id = uuid(m);
      const bytes = bytesFor(m, opts.sizes ?? 20_000 + m * 101);
      data.set(id, bytes);
      return { mediaId: id, name: `IMG_${m}.jpg`, bytes: bytes.length };
    });
    n += entries.length;
    return {
      id: uuid(9000 + i),
      partNo: i + 1,
      objectKey: archivePartKey(galleryId, jobId, i + 1),
      entries,
      itemCount: entries.length,
      sourceBytes: entries.reduce((s, e) => s + e.bytes, 0),
      uploadId: null,
      byteSize: null,
      completed: false,
    };
  });
  const job: ArchiveBuildJob = {
    id: jobId,
    galleryId,
    status: 'queued',
    contentVersion: 3,
    totalBytes: parts.reduce((s, p) => s + p.sourceBytes, 0),
    partsExpected: parts.length,
    parts,
  };
  expect(n).toBeGreaterThan(0);
  const repo = new FakeRepo(job);
  const archives = new FakeArchives();
  const deps = (extra: Partial<ArchiveBuildDeps> = {}): ArchiveBuildDeps => ({
    repo,
    originals: originalsFor(data),
    archives,
    log: silentLogger,
    attempt: 1,
    crc32: archiveCrc32,
    partBytes: 16 * 1024,
    progressIntervalMs: 0,
    contentCheckEvery: 2,
    ...extra,
  });
  return { repo, archives, data, job, deps };
}

describe('archive.build', () => {
  it('builds every part as a valid STORE zip via equal-size multipart parts, then ready', async () => {
    const { repo, archives, data, job, deps } = fixture([
      [1, 2, 3],
      [4, 5],
    ]);
    const now = Date.parse('2026-11-11T12:00:00Z');
    expect(await handleArchiveBuild(jobId, deps({ now: () => now }))).toBe('ready');
    expect(repo.status).toBe('ready');
    expect(repo.expiresAt?.getTime()).toBe(now + ARCHIVE_LIMITS.retentionMs);
    for (const part of job.parts) {
      const zip = archives.objects.get(part.objectKey)!;
      expect(repo.byteSizes.get(part.id)).toBe(zip.length);
      const entries = readZip(zip);
      expect(entries.map((e) => e.name)).toEqual(part.entries.map((e) => e.name));
      for (const [i, e] of entries.entries()) {
        expect(e.data).toEqual(data.get(part.entries[i]!.mediaId));
      }
      const sizes = archives.partSizes.get(part.objectKey)!;
      expect(sizes.length).toBeGreaterThan(1);
      expect(sizes.slice(0, -1).every((s) => s === 16 * 1024)).toBe(true);
    }
    // Progress is monotonic and never claims 100 before ready.
    expect(repo.progress).toEqual([...repo.progress].sort((a, b) => a - b));
    expect(Math.max(...repo.progress)).toBeLessThanOrEqual(99);
    expect(repo.leaseHeld).toBe(false);
  });

  it('is idempotent: a redelivery after ready does nothing', async () => {
    const { repo, archives, deps } = fixture([[1]]);
    await handleArchiveBuild(jobId, deps());
    archives.objects.clear();
    expect(await handleArchiveBuild(jobId, deps())).toBe('not_buildable');
    expect(archives.objects.size).toBe(0);
    expect(repo.status).toBe('ready');
  });

  it('resumes: skips completed parts and aborts the abandoned upload of an interrupted one', async () => {
    const { repo, archives, job, deps } = fixture([[1, 2], [3]]);
    job.parts[0]!.completed = true;
    job.parts[1]!.uploadId = 'stale-upload';
    repo.status = 'running'; // a previous delivery died mid-build; its lease expired
    expect(await handleArchiveBuild(jobId, deps())).toBe('ready');
    expect(archives.objects.has(job.parts[0]!.objectKey)).toBe(false);
    expect(archives.objects.has(job.parts[1]!.objectKey)).toBe(true);
    expect(archives.aborted).toContain('stale-upload');
  });

  it('backs off while another delivery holds the lease', async () => {
    const { repo, deps } = fixture([[1]]);
    repo.status = 'running';
    repo.leaseHeld = true;
    const error = await handleArchiveBuild(jobId, deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryLaterError);
    expect((error as RetryLaterError).delaySeconds).toBe(ARCHIVE_LIMITS.leaseMs / 1000);
  });

  it('fails with content_changed when the gallery changes mid-build (PRD §11)', async () => {
    const { repo, archives, job, deps } = fixture([[1, 2, 3, 4, 5]]);
    let calls = 0;
    repo.galleryState = async () => {
      calls++;
      // Reordered after the first content check inside the part.
      return { contentVersion: calls >= 3 ? 4 : 3, available: true };
    };
    expect(await handleArchiveBuild(jobId, deps())).toBe('failed:content_changed');
    expect(repo.status).toBe('failed');
    expect(repo.failure).toBe('content_changed');
    expect(archives.objects.has(job.parts[0]!.objectKey)).toBe(false);
    expect(archives.aborted).toHaveLength(1);
    expect(repo.uploadIds.get(job.parts[0]!.id)).toBeNull();
  });

  it('fails when the change lands between streaming and recording the part', async () => {
    const { repo, deps } = fixture([[1]]);
    repo.beforeComplete = () => {
      repo.gallery = { contentVersion: 4, available: true };
    };
    expect(await handleArchiveBuild(jobId, deps())).toBe('failed:content_changed');
  });

  it('fails with gallery_unavailable when the gallery is deleted', async () => {
    const { repo, deps } = fixture([[1]]);
    repo.gallery = { contentVersion: 3, available: false };
    expect(await handleArchiveBuild(jobId, deps())).toBe('failed:gallery_unavailable');
  });

  it('fails with content_changed when a photo was removed', async () => {
    const { repo, deps } = fixture([[1, 2]]);
    repo.undeliverable.add(uuid(2));
    expect(await handleArchiveBuild(jobId, deps())).toBe('failed:content_changed');
  });

  it('fails with original_missing when an object is gone', async () => {
    const { repo, data, deps } = fixture([[1, 2]]);
    const result = await handleArchiveBuild(
      jobId,
      deps({ originals: originalsFor(data, new Set([uuid(2)])) }),
    );
    expect(result).toBe('failed:original_missing');
    expect(repo.failure).toBe('original_missing');
  });

  it('retries transient errors, then gives up as build_failed', async () => {
    const { repo, archives, deps } = fixture([[1]]);
    archives.failUploadPart = true;
    await expect(handleArchiveBuild(jobId, deps({ attempt: 1 }))).rejects.toThrow('r2 unavailable');
    expect(repo.status).toBe('running');
    expect(repo.leaseHeld).toBe(false); // the retry can claim at once
    expect(archives.aborted).toHaveLength(1);
    const last = await handleArchiveBuild(
      jobId,
      deps({ attempt: ARCHIVE_LIMITS.maxBuildAttempts }),
    );
    expect(last).toBe('failed:build_failed');
    expect(repo.status).toBe('failed');
  });

  it('ignores missing and terminal jobs', async () => {
    const { repo, deps } = fixture([[1]]);
    repo.status = 'failed';
    expect(await handleArchiveBuild(jobId, deps())).toBe('not_buildable');
    repo.claim = async () => 'missing';
    expect(await handleArchiveBuild(jobId, deps())).toBe('missing');
  });

  it('uses a CRC implementation equal to the reference', () => {
    const sample = bytesFor(7, 99_999);
    expect(archiveCrc32(sample)).toBe(crc32(sample));
    expect(typeof nativeCrc32Available).toBe('boolean');
  });
});
