import { describe, expect, it, vi } from 'vitest';
import { ARCHIVE_LIMITS } from '@lumra/config';
import { silentLogger } from '../log';
import { sweepArchives } from './archive-sweep';

const g = '0b6f3c2e-8a51-4c1e-9d7a-2f4b5c6d7e8f';
const j1 = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const j2 = '8d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('sweepArchives (T25)', () => {
  it('expires due jobs, deletes their objects and fails stalled jobs', async () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    const repo = {
      expireDue: vi.fn(async () => [
        { jobId: j1, objectKeys: [`archives/${g}/${j1}/1.zip`, `archives/${g}/${j1}/2.zip`] },
        { jobId: j2, objectKeys: [`archives/${g}/${j2}/1.zip`, 'originals/x/../../evil'] },
      ]),
      failStalled: vi.fn(async () => 3),
    };
    const archives = { delete: vi.fn(async () => undefined) };
    const result = await sweepArchives({ repo, archives, log: silentLogger, now: () => now });
    expect(result).toEqual({ expired: 2, objectsDeleted: 3, deleteFailures: 0, stalled: 3 });
    expect(repo.expireDue).toHaveBeenCalledWith(new Date(now), ARCHIVE_LIMITS.sweepBatch);
    // Only archive keys produced by the key builder are ever deleted.
    expect(archives.delete).toHaveBeenNthCalledWith(2, [`archives/${g}/${j2}/1.zip`]);
    expect(repo.failStalled).toHaveBeenCalledWith(new Date(now - ARCHIVE_LIMITS.stalledAfterMs));
  });

  it('keeps going when a delete fails (the lifecycle rule is the backstop)', async () => {
    const repo = {
      expireDue: vi.fn(async () => [
        { jobId: j1, objectKeys: [`archives/${g}/${j1}/1.zip`] },
        { jobId: j2, objectKeys: [`archives/${g}/${j2}/1.zip`] },
      ]),
      failStalled: vi.fn(async () => 0),
    };
    const archives = {
      delete: vi.fn().mockRejectedValueOnce(new Error('r2 down')).mockResolvedValue(undefined),
    };
    const result = await sweepArchives({ repo, archives, log: silentLogger });
    expect(result).toMatchObject({ expired: 2, objectsDeleted: 1, deleteFailures: 1 });
  });
});
