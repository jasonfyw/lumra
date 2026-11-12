import { ARCHIVE_LIMITS } from '@lumra/config';
import type { ArchiveRepository } from '@lumra/db';
import { assertStorageKey } from '@lumra/media';
import type { Logger } from '../log';

/**
 * Archive retention sweep (T25, FR-D04): every 15 minutes
 * - `ready` jobs past `expires_at` (24 h) become `expired` and their ZIP objects are deleted
 *   from temp-archives (the bucket's 1-day lifecycle rule is the backstop for anything missed);
 * - queued/running jobs with no progress for `ARCHIVE_LIMITS.stalledAfterMs` and no live lease
 *   are failed as `stalled`, so the progress page offers "Try again" instead of spinning forever.
 * The status API also treats a ready job past its TTL as expired on read.
 */
export interface ArchiveSweepDeps {
  repo: Pick<ArchiveRepository, 'expireDue' | 'failStalled'>;
  archives: { delete(keys: string | string[]): Promise<void> };
  log: Logger;
  now?: () => number;
  batch?: number;
}

export interface ArchiveSweepResult {
  expired: number;
  objectsDeleted: number;
  deleteFailures: number;
  stalled: number;
}

export async function sweepArchives(deps: ArchiveSweepDeps): Promise<ArchiveSweepResult> {
  const now = new Date((deps.now ?? Date.now)());
  const result: ArchiveSweepResult = {
    expired: 0,
    objectsDeleted: 0,
    deleteFailures: 0,
    stalled: 0,
  };
  const due = await deps.repo.expireDue(now, deps.batch ?? ARCHIVE_LIMITS.sweepBatch);
  result.expired = due.length;
  for (const { jobId, objectKeys } of due) {
    const keys = objectKeys.filter((key) => {
      try {
        assertStorageKey(key);
        return key.startsWith('archives/');
      } catch {
        return false;
      }
    });
    if (keys.length === 0) continue;
    try {
      // R2 `delete` takes up to 1,000 keys; a job has at most a few parts.
      await deps.archives.delete(keys);
      result.objectsDeleted += keys.length;
    } catch (error) {
      result.deleteFailures++;
      deps.log.warn('archive object delete failed', { jobId, parts: keys.length, err: error });
    }
  }
  result.stalled = await deps.repo.failStalled(
    new Date(now.getTime() - ARCHIVE_LIMITS.stalledAfterMs),
  );
  return result;
}
