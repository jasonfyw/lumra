import type { DeletionRepository, MediaPurgeRow } from '@lumra/db';
import { deletionSweepCutoff, mediaPurgeDecision, purgedMediaStatus } from '@lumra/domain';
import { archiveGalleryPrefix, derivativeGalleryPrefix, isStorageKey } from '@lumra/media';
import type { Logger } from '../log';

/**
 * Physical deletion executor (FR-G06, T13). The web app soft-deletes first (media `deleting`,
 * gallery `deleted`, both with `deleted_at`) and writes a `media.delete` / `gallery.delete`
 * outbox row; these functions then remove the R2 objects and mark each media row `deleted`.
 *
 * Order per media: delete the original and every derivative, THEN mark the row `deleted`. A crash
 * in between leaves the row `deleting`, so a redelivery or the backstop sweep repeats the deletes
 * (R2 deletes of missing keys are no-ops) and then marks it. Every step is idempotent and safe to
 * run concurrently. Live media (neither it nor its gallery deleted) are never touched.
 *
 * Logs carry ids and counts only, never object keys (originals keys embed owner ids).
 */

/** R2 accepts up to 1,000 keys per `delete` call. */
export const R2_DELETE_BATCH = 1_000;
/** Media per DB read / R2 delete round when purging a gallery or sweeping. */
export const PURGE_MEDIA_BATCH = 200;

export interface PurgeBucket {
  delete(keys: string[]): Promise<void>;
}

export interface ListablePurgeBucket extends PurgeBucket {
  list(options: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

export interface PurgeDeps {
  repo: DeletionRepository;
  originals: PurgeBucket;
  derivatives: ListablePurgeBucket;
  archives: ListablePurgeBucket;
  log: Logger;
  /** Milliseconds clock for time budgets (tests pin it). */
  now?: () => number;
}

export interface MediaPurgeResult {
  /** Rows whose objects were deleted and that were marked `deleted` by this run. */
  purged: number;
  /** Already `deleted` (redelivery) or marked by a concurrent run. */
  alreadyPurged: number;
  /** Not deleted at all: refused. */
  live: number;
  /** No such row (hard-deleted, or a bogus id). */
  missing: number;
  /** Object keys sent to R2 delete (missing objects count too; R2 doesn't say). */
  objectKeys: number;
  /** Stored keys that don't match the key scheme; skipped and logged, left for the R2 reconcile. */
  invalidKeys: number;
}

const emptyMediaResult = (): MediaPurgeResult => ({
  purged: 0,
  alreadyPurged: 0,
  live: 0,
  missing: 0,
  objectKeys: 0,
  invalidKeys: 0,
});

function addMediaResult(into: MediaPurgeResult, from: MediaPurgeResult): void {
  for (const key of Object.keys(into) as (keyof MediaPurgeResult)[]) into[key] += from[key];
}

async function deleteKeys(bucket: PurgeBucket, keys: readonly string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
    await bucket.delete(keys.slice(i, i + R2_DELETE_BATCH));
  }
}

/**
 * Purges a batch of media ids: one DB read, one R2 delete per bucket (per 1,000 keys), one DB
 * update. Throws on any R2/DB failure without marking anything, so the caller retries.
 */
export async function purgeMedia(
  mediaIds: readonly string[],
  deps: PurgeDeps,
): Promise<MediaPurgeResult> {
  const result = emptyMediaResult();
  const unique = [...new Set(mediaIds)];
  if (unique.length === 0) return result;
  const rows = await deps.repo.getMediaForPurge(unique);
  result.missing = unique.length - rows.length;

  const toPurge: MediaPurgeRow[] = [];
  for (const row of rows) {
    const decision = mediaPurgeDecision(row);
    if (decision === 'purge') toPurge.push(row);
    else if (decision === 'already_purged') result.alreadyPurged++;
    else {
      result.live++;
      deps.log.warn('purge refused: media is not deleted', { mediaId: row.id });
    }
  }
  if (toPurge.length === 0) return result;

  const originalKeys: string[] = [];
  const derivativeKeys: string[] = [];
  for (const row of toPurge) {
    purgedMediaStatus(row.status); // asserts the PRD §7 transition
    let invalid = 0;
    if (isStorageKey(row.originalKey)) originalKeys.push(row.originalKey);
    else invalid++;
    for (const key of row.variantKeys) {
      if (isStorageKey(key)) derivativeKeys.push(key);
      else invalid++;
    }
    if (invalid > 0) {
      result.invalidKeys += invalid;
      deps.log.error('purge skipped invalid object keys', { mediaId: row.id, count: invalid });
    }
  }
  await deleteKeys(deps.originals, originalKeys);
  await deleteKeys(deps.derivatives, derivativeKeys);
  result.objectKeys = originalKeys.length + derivativeKeys.length;

  const marked = await deps.repo.markMediaDeleted(toPurge.map((r) => r.id));
  result.purged = marked.length;
  result.alreadyPurged += toPurge.length - marked.length;
  return result;
}

/**
 * Deletes every object under `prefix` (paged by R2's list cursor). Only keys that match the key
 * scheme AND the prefix are deleted. `complete` is false when the time budget ran out first.
 */
async function deletePrefix(
  bucket: ListablePurgeBucket,
  prefix: string,
  outOfTime: () => boolean,
): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    if (outOfTime()) return { deleted, complete: false };
    const page = await bucket.list({
      prefix,
      limit: R2_DELETE_BATCH,
      ...(cursor ? { cursor } : {}),
    });
    const keys = page.objects
      .map((o) => o.key)
      .filter((key) => key.startsWith(prefix) && isStorageKey(key));
    if (keys.length > 0) await bucket.delete(keys);
    deleted += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { deleted, complete: true };
}

export type GalleryPurgeOutcome = 'purged' | 'incomplete' | 'live' | 'missing';

export interface GalleryPurgeResult {
  outcome: GalleryPurgeOutcome;
  media: MediaPurgeResult;
  /** Derivative objects found by listing the gallery prefix (orphans of failed jobs included). */
  derivativePrefixObjects: number;
  archiveObjects: number;
  archiveJobs: number;
}

/**
 * Purges a deleted gallery: every media (bounded batches), then everything left under its
 * derivatives prefix and its temp-archive prefix, then its archive jobs are marked `deleted`.
 * A gallery row that no longer exists only gets the prefix deletes. Returns `incomplete` when
 * `budgetMs` runs out; progress is kept (finished media are `deleted`), so a rerun continues.
 */
export async function purgeGallery(
  galleryId: string,
  deps: PurgeDeps,
  options: { budgetMs: number; batchSize?: number },
): Promise<GalleryPurgeResult> {
  const now = deps.now ?? Date.now;
  const deadline = now() + options.budgetMs;
  const outOfTime = () => now() >= deadline;
  const batchSize = options.batchSize ?? PURGE_MEDIA_BATCH;
  const result: GalleryPurgeResult = {
    outcome: 'purged',
    media: emptyMediaResult(),
    derivativePrefixObjects: 0,
    archiveObjects: 0,
    archiveJobs: 0,
  };

  const gallery = await deps.repo.getGalleryDeletion(galleryId);
  if (gallery && !gallery.deleted) {
    deps.log.warn('purge refused: gallery is not deleted', { galleryId });
    return { ...result, outcome: 'live' };
  }

  if (gallery) {
    let after: string | null = null;
    while (true) {
      if (outOfTime()) return { ...result, outcome: 'incomplete' };
      const ids = await deps.repo.listGalleryMediaToPurge(galleryId, after, batchSize);
      if (ids.length === 0) break;
      addMediaResult(result.media, await purgeMedia(ids, deps));
      after = ids[ids.length - 1]!;
      if (ids.length < batchSize) break;
    }
  }

  const derivatives = await deletePrefix(
    deps.derivatives,
    derivativeGalleryPrefix(galleryId),
    outOfTime,
  );
  result.derivativePrefixObjects = derivatives.deleted;
  if (!derivatives.complete) return { ...result, outcome: 'incomplete' };

  const archives = await deletePrefix(deps.archives, archiveGalleryPrefix(galleryId), outOfTime);
  result.archiveObjects = archives.deleted;
  if (!archives.complete) return { ...result, outcome: 'incomplete' };
  if (gallery) result.archiveJobs = await deps.repo.markGalleryArchivesDeleted(galleryId);

  return { ...result, outcome: gallery ? 'purged' : 'missing' };
}

export interface SweepResult {
  galleries: number;
  galleriesIncomplete: number;
  galleriesFailed: number;
  media: MediaPurgeResult;
  mediaBatchesFailed: number;
  /** The time budget ran out before the backlog was empty. */
  budgetExhausted: boolean;
}

/**
 * Backstop sweep (cron, T13): finds deletions older than the grace period that never finished
 * (lost or dead-lettered jobs, provider outages) and purges them within `budgetMs`. Deleted
 * galleries with leftovers go first (they also cover their media), then individually deleted
 * media. Per-gallery / per-batch failures are logged and counted without aborting the sweep.
 */
export async function sweepDeletions(
  deps: PurgeDeps,
  options: {
    budgetMs: number;
    nowDate?: Date;
    graceMs?: number;
    galleryLimit?: number;
    batchSize?: number;
  },
): Promise<SweepResult> {
  const now = deps.now ?? Date.now;
  const deadline = now() + options.budgetMs;
  const remaining = () => deadline - now();
  const cutoff = deletionSweepCutoff(options.nowDate ?? new Date(), options.graceMs);
  const batchSize = options.batchSize ?? PURGE_MEDIA_BATCH;
  const result: SweepResult = {
    galleries: 0,
    galleriesIncomplete: 0,
    galleriesFailed: 0,
    media: emptyMediaResult(),
    mediaBatchesFailed: 0,
    budgetExhausted: false,
  };

  const galleryIds = await deps.repo.listStuckGalleries(cutoff, options.galleryLimit ?? 10);
  for (const galleryId of galleryIds) {
    if (remaining() <= 0) {
      result.budgetExhausted = true;
      return result;
    }
    result.galleries++;
    try {
      const purged = await purgeGallery(galleryId, deps, { budgetMs: remaining(), batchSize });
      addMediaResult(result.media, purged.media);
      if (purged.outcome === 'incomplete') result.galleriesIncomplete++;
      deps.log.info('sweep purged gallery', {
        galleryId,
        outcome: purged.outcome,
        media: purged.media.purged,
        archiveJobs: purged.archiveJobs,
      });
    } catch (error) {
      result.galleriesFailed++;
      deps.log.warn('sweep gallery purge failed', { galleryId, err: error });
    }
  }

  while (remaining() > 0) {
    const ids = await deps.repo.listStuckMedia(cutoff, batchSize);
    if (ids.length === 0) return result;
    try {
      const batch = await purgeMedia(ids, deps);
      addMediaResult(result.media, batch);
      // Nothing changed (e.g. a concurrent run took these rows): stop instead of spinning.
      if (batch.purged === 0) return result;
    } catch (error) {
      result.mediaBatchesFailed++;
      deps.log.warn('sweep media purge failed', { size: ids.length, err: error });
      return result;
    }
    if (ids.length < batchSize) return result;
  }
  result.budgetExhausted = true;
  return result;
}
