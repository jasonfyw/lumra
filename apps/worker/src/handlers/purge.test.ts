import { describe, expect, it, vi } from 'vitest';
import type { DeletionRepository, MediaPurgeRow } from '@lumra/db';
import type { MediaStatus } from '@lumra/contracts';
import { archivePartKey, derivativeKey, originalKey } from '@lumra/media';
import { silentLogger } from '../log';
import { purgeGallery, purgeMedia, sweepDeletions, type ListablePurgeBucket } from './purge';

const G1 = '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f';
const G2 = '1c7f4d3f-9b62-4d2f-8e8b-3a5c6d7e8f90';
const OWNER = 'owner-12345678';
const mid = (n: number) => `9a8b7c6d-5e4f-4a3b-8c2d-${String(n).padStart(12, '0')}`;

/** In-memory R2 bucket: deleting a missing key is a no-op, like R2. */
class FakeBucket implements ListablePurgeBucket {
  readonly objects = new Set<string>();
  readonly deleteCalls: string[][] = [];
  failDeletes = false;
  constructor(keys: string[] = []) {
    for (const k of keys) this.objects.add(k);
  }
  async delete(keys: string[]) {
    if (this.failDeletes) throw new Error('r2 unavailable');
    this.deleteCalls.push(keys);
    for (const k of keys) this.objects.delete(k);
  }
  async list({
    prefix,
    cursor,
    limit = 1000,
  }: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }) {
    const all = [...this.objects].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + limit);
    const truncated = start + limit < all.length;
    return {
      objects: page.map((key) => ({ key })),
      truncated,
      ...(truncated ? { cursor: String(start + limit) } : {}),
    };
  }
}

interface FakeMedia {
  id: string;
  galleryId: string;
  status: MediaStatus;
  deletedAt: Date | null;
  variants: string[];
}
interface FakeGallery {
  deletedAt: Date | null;
  archiveJobs: { status: string }[];
}

/** In-memory DeletionRepository with the same conditional semantics as the SQL version. */
class FakeRepo implements DeletionRepository {
  media = new Map<string, FakeMedia>();
  galleries = new Map<string, FakeGallery>();
  constructor(private readonly now = () => new Date('2026-11-11T12:00:00Z')) {}

  addGallery(id: string, deletedAt: Date | null, archiveJobs: { status: string }[] = []) {
    this.galleries.set(id, { deletedAt, archiveJobs });
  }
  addMedia(m: FakeMedia) {
    this.media.set(m.id, m);
  }
  private galleryDeleted(m: FakeMedia) {
    return Boolean(this.galleries.get(m.galleryId)?.deletedAt);
  }

  async getMediaForPurge(ids: readonly string[]): Promise<MediaPurgeRow[]> {
    return ids.flatMap((id) => {
      const m = this.media.get(id);
      if (!m) return [];
      return [
        {
          id: m.id,
          galleryId: m.galleryId,
          status: m.status,
          originalKey: originalKey(OWNER, m.galleryId, m.id),
          mediaDeleted: m.deletedAt !== null,
          galleryDeleted: this.galleryDeleted(m),
          variantKeys: [...m.variants],
        },
      ];
    });
  }
  async markMediaDeleted(ids: readonly string[]) {
    const changed: string[] = [];
    for (const id of ids) {
      const m = this.media.get(id);
      if (!m || m.status === 'deleted') continue;
      if (!m.deletedAt && !this.galleryDeleted(m)) continue;
      m.status = 'deleted';
      m.deletedAt ??= this.now();
      changed.push(id);
    }
    return changed;
  }
  async getGalleryDeletion(id: string) {
    const g = this.galleries.get(id);
    return g ? { id, deleted: g.deletedAt !== null } : null;
  }
  async listGalleryMediaToPurge(galleryId: string, afterId: string | null, limit: number) {
    return [...this.media.values()]
      .filter((m) => m.galleryId === galleryId && m.status !== 'deleted')
      .map((m) => m.id)
      .filter((id) => afterId === null || id > afterId)
      .sort()
      .slice(0, limit);
  }
  async markGalleryArchivesDeleted(galleryId: string) {
    let n = 0;
    for (const job of this.galleries.get(galleryId)?.archiveJobs ?? []) {
      if (job.status !== 'deleted') {
        job.status = 'deleted';
        n++;
      }
    }
    return n;
  }
  async listStuckGalleries(cutoff: Date, limit: number) {
    return [...this.galleries.entries()]
      .filter(([id, g]) => {
        if (!g.deletedAt || g.deletedAt >= cutoff) return false;
        const media = [...this.media.values()].some(
          (m) => m.galleryId === id && m.status !== 'deleted',
        );
        return media || g.archiveJobs.some((j) => j.status !== 'deleted');
      })
      .map(([id]) => id)
      .slice(0, limit);
  }
  async listStuckMedia(cutoff: Date, limit: number) {
    return [...this.media.values()]
      .filter((m) => m.status !== 'deleted' && m.deletedAt !== null && m.deletedAt < cutoff)
      .map((m) => m.id)
      .slice(0, limit);
  }
}

const HOUR = 3_600_000;
const NOW = new Date('2026-11-11T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function seedMedia(
  repo: FakeRepo,
  buckets: { originals: FakeBucket; derivatives: FakeBucket },
  galleryId: string,
  n: number,
  status: MediaStatus,
  deletedAt: Date | null,
) {
  const id = mid(n);
  const variants = ['w640q80', 'w1280q80'].map((h) => derivativeKey(galleryId, id, h));
  repo.addMedia({ id, galleryId, status, deletedAt, variants });
  buckets.originals.objects.add(originalKey(OWNER, galleryId, id));
  for (const v of variants) buckets.derivatives.objects.add(v);
  return id;
}

function setup() {
  const repo = new FakeRepo();
  const originals = new FakeBucket();
  const derivatives = new FakeBucket();
  const archives = new FakeBucket();
  const deps = { repo, originals, derivatives, archives, log: silentLogger };
  return { repo, originals, derivatives, archives, deps };
}

describe('purgeMedia (media.delete)', () => {
  it('deletes the original and every derivative, then marks the row deleted', async () => {
    const { repo, originals, derivatives, deps } = setup();
    repo.addGallery(G1, null);
    const id = seedMedia(repo, { originals, derivatives }, G1, 1, 'deleting', ago(1000));
    const other = seedMedia(repo, { originals, derivatives }, G1, 2, 'ready', null);

    const result = await purgeMedia([id], deps);
    expect(result).toMatchObject({ purged: 1, live: 0, missing: 0, objectKeys: 3 });
    expect(repo.media.get(id)!.status).toBe('deleted');
    // Only the deleted item's objects are gone; the live sibling is untouched.
    expect([...originals.objects]).toEqual([originalKey(OWNER, G1, other)]);
    expect([...derivatives.objects].every((k) => k.includes(other))).toBe(true);
    expect(derivatives.objects.size).toBe(2);
  });

  it('is idempotent: a second run (redelivery) does nothing and succeeds', async () => {
    const { repo, originals, derivatives, deps } = setup();
    repo.addGallery(G1, null);
    const id = seedMedia(repo, { originals, derivatives }, G1, 1, 'deleting', ago(1000));
    await purgeMedia([id], deps);
    const calls = originals.deleteCalls.length;
    const again = await purgeMedia([id], deps);
    expect(again).toMatchObject({ purged: 0, alreadyPurged: 1, objectKeys: 0 });
    expect(originals.deleteCalls.length).toBe(calls);
  });

  it('retries the deletes after a crash between R2 and the DB mark (missing keys are no-ops)', async () => {
    const { repo, originals, derivatives, deps } = setup();
    repo.addGallery(G1, null);
    const id = seedMedia(repo, { originals, derivatives }, G1, 1, 'deleting', ago(1000));
    const mark = vi.spyOn(repo, 'markMediaDeleted').mockRejectedValueOnce(new Error('db down'));
    await expect(purgeMedia([id], deps)).rejects.toThrow('db down');
    expect(originals.objects.size).toBe(0);
    expect(repo.media.get(id)!.status).toBe('deleting');
    mark.mockRestore();
    expect(await purgeMedia([id], deps)).toMatchObject({ purged: 1 });
    expect(repo.media.get(id)!.status).toBe('deleted');
  });

  it('does not mark the row when R2 fails, so the queue retries', async () => {
    const { repo, originals, derivatives, deps } = setup();
    repo.addGallery(G1, null);
    const id = seedMedia(repo, { originals, derivatives }, G1, 1, 'deleting', ago(1000));
    derivatives.failDeletes = true;
    await expect(purgeMedia([id], deps)).rejects.toThrow('r2 unavailable');
    expect(repo.media.get(id)!.status).toBe('deleting');
  });

  it('refuses live media and ignores unknown ids', async () => {
    const { repo, originals, derivatives, deps } = setup();
    repo.addGallery(G1, null);
    const live = seedMedia(repo, { originals, derivatives }, G1, 1, 'ready', null);
    const result = await purgeMedia([live, mid(99)], deps);
    expect(result).toMatchObject({ purged: 0, live: 1, missing: 1 });
    expect(originals.objects.size).toBe(1);
    expect(originals.deleteCalls).toEqual([]);
    expect(repo.media.get(live)!.status).toBe('ready');
  });

  it('skips stored keys outside the key scheme instead of sending them to R2', async () => {
    const { repo, originals, derivatives, deps } = setup();
    repo.addGallery(G1, null);
    const id = seedMedia(repo, { originals, derivatives }, G1, 1, 'deleting', ago(1000));
    repo.media.get(id)!.variants.push('../../etc/passwd');
    const result = await purgeMedia([id], deps);
    expect(result).toMatchObject({ purged: 1, invalidKeys: 1, objectKeys: 3 });
    expect(derivatives.deleteCalls.flat()).not.toContain('../../etc/passwd');
  });
});

describe('purgeGallery (gallery.delete)', () => {
  it('purges every media in batches, the derivative and archive prefixes, and archive jobs', async () => {
    const { repo, originals, derivatives, archives, deps } = setup();
    repo.addGallery(G1, ago(1000), [{ status: 'ready' }, { status: 'failed' }]);
    repo.addGallery(G2, null);
    const statuses: MediaStatus[] = ['reserved', 'uploading', 'processing', 'ready', 'failed'];
    statuses.forEach((s, i) => seedMedia(repo, { originals, derivatives }, G1, i + 1, s, null));
    const keep = seedMedia(repo, { originals, derivatives }, G2, 50, 'ready', null);
    // An orphan derivative without a DB row, and two archive parts.
    derivatives.objects.add(derivativeKey(G1, mid(77), 'w640q80'));
    archives.objects.add(archivePartKey(G1, mid(88), 1));
    archives.objects.add(archivePartKey(G1, mid(88), 2));
    archives.objects.add(archivePartKey(G2, mid(89), 1));

    const result = await purgeGallery(G1, deps, { budgetMs: 60_000, batchSize: 2 });
    expect(result).toMatchObject({
      outcome: 'purged',
      archiveObjects: 2,
      archiveJobs: 2,
      derivativePrefixObjects: 1,
    });
    expect(result.media.purged).toBe(5);
    for (const m of repo.media.values()) {
      expect(m.status).toBe(m.galleryId === G1 ? 'deleted' : 'ready');
      if (m.galleryId === G1) expect(m.deletedAt).not.toBeNull();
    }
    expect([...originals.objects]).toEqual([originalKey(OWNER, G2, keep)]);
    expect([...derivatives.objects].every((k) => k.startsWith(`derivatives/${G2}/`))).toBe(true);
    expect([...archives.objects]).toEqual([archivePartKey(G2, mid(89), 1)]);

    // Idempotent.
    const again = await purgeGallery(G1, deps, { budgetMs: 60_000 });
    expect(again).toMatchObject({ outcome: 'purged', archiveJobs: 0, archiveObjects: 0 });
    expect(again.media.purged).toBe(0);
  });

  it('refuses a gallery that is not deleted', async () => {
    const { repo, originals, derivatives, deps } = setup();
    repo.addGallery(G1, null);
    seedMedia(repo, { originals, derivatives }, G1, 1, 'ready', null);
    expect((await purgeGallery(G1, deps, { budgetMs: 60_000 })).outcome).toBe('live');
    expect(originals.objects.size).toBe(1);
    expect(derivatives.objects.size).toBe(2);
  });

  it('removes prefix objects of a gallery row that no longer exists', async () => {
    const { archives, derivatives, deps } = setup();
    derivatives.objects.add(derivativeKey(G1, mid(1), 'w640q80'));
    archives.objects.add(archivePartKey(G1, mid(2), 1));
    const result = await purgeGallery(G1, deps, { budgetMs: 60_000 });
    expect(result.outcome).toBe('missing');
    expect(derivatives.objects.size + archives.objects.size).toBe(0);
  });

  it('stops at the time budget with progress kept, and a rerun finishes', async () => {
    const { repo, originals, derivatives, deps } = setup();
    repo.addGallery(G1, ago(1000));
    for (let i = 1; i <= 5; i++) seedMedia(repo, { originals, derivatives }, G1, i, 'ready', null);
    let clock = 0;
    const timed = { ...deps, now: () => clock };
    const purge = repo.markMediaDeleted.bind(repo);
    vi.spyOn(repo, 'markMediaDeleted').mockImplementation(async (ids) => {
      clock += 10;
      return purge(ids);
    });
    const first = await purgeGallery(G1, timed, { budgetMs: 15, batchSize: 2 });
    expect(first.outcome).toBe('incomplete');
    expect(first.media.purged).toBe(4);
    const second = await purgeGallery(G1, timed, { budgetMs: 1_000, batchSize: 2 });
    expect(second.outcome).toBe('purged');
    expect([...repo.media.values()].every((m) => m.status === 'deleted')).toBe(true);
    expect(originals.objects.size).toBe(0);
  });
});

describe('sweepDeletions (backstop cron)', () => {
  it('picks up stuck deleting media and deleted galleries older than the grace period', async () => {
    const { repo, originals, derivatives, deps } = setup();
    repo.addGallery(G1, null);
    repo.addGallery(G2, ago(2 * HOUR));
    // Stuck for days (e.g. the media.delete job dead-lettered before this handler existed).
    const stuck = seedMedia(repo, { originals, derivatives }, G1, 1, 'deleting', ago(72 * HOUR));
    // Deleted moments ago: its queued job owns it, the sweep leaves it alone.
    const fresh = seedMedia(repo, { originals, derivatives }, G1, 2, 'deleting', ago(60_000));
    const live = seedMedia(repo, { originals, derivatives }, G1, 3, 'ready', null);
    const inDeletedGallery = seedMedia(repo, { originals, derivatives }, G2, 4, 'ready', null);

    const result = await sweepDeletions(deps, { budgetMs: 50_000, nowDate: NOW });
    expect(result).toMatchObject({ galleries: 1, galleriesFailed: 0, budgetExhausted: false });
    expect(result.media.purged).toBe(2);
    expect(repo.media.get(stuck)!.status).toBe('deleted');
    expect(repo.media.get(inDeletedGallery)!.status).toBe('deleted');
    expect(repo.media.get(fresh)!.status).toBe('deleting');
    expect(repo.media.get(live)!.status).toBe('ready');
    expect(originals.objects).toEqual(
      new Set([originalKey(OWNER, G1, fresh), originalKey(OWNER, G1, live)]),
    );

    // Running again finds nothing.
    const again = await sweepDeletions(deps, { budgetMs: 50_000, nowDate: NOW });
    expect(again).toMatchObject({ galleries: 0 });
    expect(again.media.purged).toBe(0);
  });

  it('keeps sweeping after one gallery fails and stops a failing media batch without spinning', async () => {
    const { repo, originals, derivatives, deps } = setup();
    repo.addGallery(G1, ago(2 * HOUR));
    repo.addGallery(G2, null);
    seedMedia(repo, { originals, derivatives }, G1, 1, 'ready', null);
    seedMedia(repo, { originals, derivatives }, G2, 2, 'deleting', ago(2 * HOUR));
    originals.failDeletes = true;
    const listStuck = vi.spyOn(repo, 'listStuckMedia');
    const result = await sweepDeletions(deps, { budgetMs: 50_000, nowDate: NOW });
    expect(result).toMatchObject({ galleries: 1, galleriesFailed: 1, mediaBatchesFailed: 1 });
    expect(listStuck).toHaveBeenCalledOnce();
  });

  it('honours the time budget', async () => {
    const { repo, originals, derivatives, deps } = setup();
    repo.addGallery(G1, null);
    for (let i = 1; i <= 6; i++) {
      seedMedia(repo, { originals, derivatives }, G1, i, 'deleting', ago(2 * HOUR));
    }
    let clock = 0;
    const purge = repo.markMediaDeleted.bind(repo);
    vi.spyOn(repo, 'markMediaDeleted').mockImplementation(async (ids) => {
      clock += 30;
      return purge(ids);
    });
    const result = await sweepDeletions(
      { ...deps, now: () => clock },
      { budgetMs: 50, nowDate: NOW, batchSize: 2 },
    );
    expect(result.budgetExhausted).toBe(true);
    expect(result.media.purged).toBe(4);
  });
});
