import { describe, expect, it } from 'vitest';
import { galleryAccessStateSchema } from '@lumra/contracts';
import type { AccessStateRepository, GalleryAccessRow } from '@lumra/db';
import { createKvGalleryAccessStore, evaluateGalleryAccess } from '@lumra/tokens';
import { silentLogger } from '../log';
import {
  isDeliverySuspended,
  reconcileAccessStates,
  syncGalleryAccessState,
  type AccessStateDeps,
} from './access-state';

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const G3 = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-11-05T12:00:00.000Z');

class FakeKv {
  readonly data = new Map<string, string>();
  puts = 0;
  failNext = false;
  async put(key: string, value: string) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('kv unavailable');
    }
    this.puts++;
    this.data.set(key, value);
  }
  async get(key: string, _type: 'text') {
    return this.data.get(key) ?? null;
  }
  doc(id: string) {
    const raw = this.data.get(`gallery:${id}`);
    return raw === undefined ? undefined : galleryAccessStateSchema.parse(JSON.parse(raw));
  }
}

function fakeRepo(rows: Map<string, GalleryAccessRow>): AccessStateRepository {
  return {
    async getGalleryAccess(id) {
      return rows.get(id) ?? null;
    },
    async listSyncableGalleryIds(after, limit) {
      return [...rows.values()]
        .filter((r) => r.status === 'published' || r.status === 'deleted' || r.deletedAt)
        .map((r) => r.id)
        .sort()
        .filter((id) => after === null || id > after)
        .slice(0, limit);
    },
  };
}

const published = (id: string, extra: Partial<GalleryAccessRow> = {}): GalleryAccessRow => ({
  id,
  status: 'published',
  deletedAt: null,
  accessVersion: 1,
  expiresAt: null,
  billing: {
    status: 'free',
    pastDueSince: null,
    restrictedSince: null,
    canceledAt: null,
  },
  ...extra,
});

function setup(rows: GalleryAccessRow[]) {
  const map = new Map(rows.map((r) => [r.id, r]));
  const kv = new FakeKv();
  const deps: AccessStateDeps = { repo: fakeRepo(map), kv, log: silentLogger, now: () => now };
  return { map, kv, deps };
}

describe('syncGalleryAccessState', () => {
  it('writes the published state the gateway accepts', async () => {
    const { kv, deps } = setup([published(G1, { accessVersion: 4 })]);
    expect(await syncGalleryAccessState(G1, deps)).toBe('written');
    expect(kv.doc(G1)).toMatchObject({ accessVersion: 4, deleted: false, expiresAt: null });
    const store = createKvGalleryAccessStore(kv, { memoTtlMs: 0 });
    expect(evaluateGalleryAccess(await store.get(G1), 4, now)).toBe('allow');
    expect(evaluateGalleryAccess(await store.get(G1), 3, now)).toBe('revoked');
  });

  it('a version bump (password change) revokes older tokens; re-delivery is idempotent', async () => {
    const { map, kv, deps } = setup([published(G1)]);
    await syncGalleryAccessState(G1, deps);
    map.set(G1, published(G1, { accessVersion: 2 }));
    await syncGalleryAccessState(G1, deps);
    await syncGalleryAccessState(G1, deps);
    const store = createKvGalleryAccessStore(kv, { memoTtlMs: 0 });
    expect(evaluateGalleryAccess(await store.get(G1), 1, now)).toBe('revoked');
    expect(evaluateGalleryAccess(await store.get(G1), 2, now)).toBe('allow');
    expect(kv.doc(G1)?.accessVersion).toBe(2);
  });

  it('mirrors expiry; the gateway computes expired itself', async () => {
    const past = new Date(now.getTime() - 60_000);
    const { kv, deps } = setup([published(G1, { expiresAt: past })]);
    await syncGalleryAccessState(G1, deps);
    expect(kv.doc(G1)?.expiresAt).toBe(past.toISOString());
    const store = createKvGalleryAccessStore(kv, { memoTtlMs: 0 });
    expect(evaluateGalleryAccess(await store.get(G1), 1, now)).toBe('expired');
  });

  it('tombstones deleted and vanished galleries (gateway 404)', async () => {
    const { kv, deps } = setup([published(G1, { status: 'deleted', deletedAt: now })]);
    expect(await syncGalleryAccessState(G1, deps)).toBe('tombstoned');
    expect(kv.doc(G1)?.deleted).toBe(true);
    expect(await syncGalleryAccessState(G2, deps)).toBe('tombstoned');
    expect(kv.doc(G2)?.deleted).toBe(true);
    const store = createKvGalleryAccessStore(kv, { memoTtlMs: 0 });
    expect(evaluateGalleryAccess(await store.get(G1), 1, now)).toBe('not_found');
  });

  it('writes nothing for drafts', async () => {
    const { kv, deps } = setup([published(G1, { status: 'draft' })]);
    expect(await syncGalleryAccessState(G1, deps)).toBe('skipped_draft');
    expect(kv.puts).toBe(0);
  });

  it('suspends delivery for restricted billing accounts', async () => {
    const restricted = published(G1, {
      billing: {
        status: 'restricted',
        pastDueSince: new Date('2026-10-01T00:00:00Z'),
        restrictedSince: new Date('2026-10-08T00:00:00Z'),
        canceledAt: null,
      },
    });
    const { kv, deps } = setup([restricted]);
    await syncGalleryAccessState(G1, deps);
    expect(kv.doc(G1)?.deliverySuspended).toBe(true);
    const store = createKvGalleryAccessStore(kv, { memoTtlMs: 0 });
    expect(evaluateGalleryAccess(await store.get(G1), 1, now)).toBe('suspended');
  });

  it('propagates KV failures so the queue retries', async () => {
    const { kv, deps } = setup([published(G1)]);
    kv.failNext = true;
    await expect(syncGalleryAccessState(G1, deps)).rejects.toThrow('kv unavailable');
  });
});

describe('isDeliverySuspended', () => {
  it('guest galleries and active accounts deliver; broken billing rows fail closed', () => {
    expect(isDeliverySuspended(published(G1, { billing: null }), now)).toBe(false);
    expect(isDeliverySuspended(published(G1), now)).toBe(false);
    const recentPastDue = published(G1, {
      billing: {
        status: 'past_due',
        pastDueSince: new Date(now.getTime() - 86_400_000),
        restrictedSince: null,
        canceledAt: null,
      },
    });
    expect(isDeliverySuspended(recentPastDue, now)).toBe(false);
    const broken = published(G1, {
      billing: {
        status: 'past_due',
        pastDueSince: null,
        restrictedSince: null,
        canceledAt: null,
      },
    });
    expect(isDeliverySuspended(broken, now)).toBe(true);
  });

  it('never suspends delivery for usage: only billing status counts (ADR-008)', () => {
    for (const status of ['free', 'active'] as const) {
      const busy = published(G1, {
        billing: { status, pastDueSince: null, restrictedSince: null, canceledAt: null },
      });
      expect(isDeliverySuspended(busy, now)).toBe(false);
    }
    const canceled = published(G1, {
      billing: {
        status: 'canceled',
        pastDueSince: null,
        restrictedSince: null,
        canceledAt: new Date(now.getTime() - 86_400_000),
      },
    });
    expect(isDeliverySuspended(canceled, now)).toBe(true);
  });
});

describe('reconcileAccessStates', () => {
  it('rewrites every published/deleted gallery across pages and skips drafts', async () => {
    const { kv, deps } = setup([
      published(G1),
      published(G2, { status: 'draft' }),
      published(G3, { status: 'deleted', deletedAt: now }),
    ]);
    const result = await reconcileAccessStates(deps, { batchSize: 1 });
    expect(result).toEqual({ scanned: 2, written: 1, tombstoned: 1, failed: 0 });
    expect(kv.doc(G1)?.deleted).toBe(false);
    expect(kv.doc(G2)).toBeUndefined();
    expect(kv.doc(G3)?.deleted).toBe(true);
  });

  it('counts per-gallery failures without aborting', async () => {
    const { kv, deps } = setup([published(G1), published(G3)]);
    kv.failNext = true;
    const result = await reconcileAccessStates(deps);
    expect(result).toMatchObject({ scanned: 2, written: 1, failed: 1 });
  });
});
