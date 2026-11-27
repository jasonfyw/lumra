import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../log';
import { sweepExpiredGuestDrafts } from './guest-drafts';

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `0b6f3c2e-8a51-4c1e-9d7a-${String(i).padStart(12, '0')}`);

describe('sweepExpiredGuestDrafts (FR-A03)', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');

  it('expires due drafts as of the tick time and stops on a short batch', async () => {
    const repo = { expireGuestDrafts: vi.fn(async () => ids(3)) };
    const result = await sweepExpiredGuestDrafts({ repo, log: silentLogger, now: () => now });
    expect(result).toEqual({ expired: 3, batches: 1 });
    expect(repo.expireGuestDrafts).toHaveBeenCalledWith(new Date(now), 100);
  });

  it('does nothing when no draft has expired', async () => {
    const repo = { expireGuestDrafts: vi.fn(async () => []) };
    expect(await sweepExpiredGuestDrafts({ repo, log: silentLogger })).toEqual({
      expired: 0,
      batches: 1,
    });
  });

  it('drains a backlog in batches, bounded by maxBatches', async () => {
    const repo = { expireGuestDrafts: vi.fn(async () => ids(2)) };
    const result = await sweepExpiredGuestDrafts({
      repo,
      log: silentLogger,
      batch: 2,
      maxBatches: 3,
    });
    expect(result).toEqual({ expired: 6, batches: 3 });
    expect(repo.expireGuestDrafts).toHaveBeenCalledTimes(3);
  });

  it('propagates repository failures so the tick reports them', async () => {
    const repo = {
      expireGuestDrafts: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    await expect(sweepExpiredGuestDrafts({ repo, log: silentLogger })).rejects.toThrow('db down');
  });
});
