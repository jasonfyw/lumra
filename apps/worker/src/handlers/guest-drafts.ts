import type { GuestDraftExpiryRepository } from '@lumra/db';
import type { Logger } from '../log';

/**
 * Guest draft expiry sweep (FR-A03, T13). A guest draft lives 24 hours from creation. Once its
 * session has expired unclaimed, the draft gallery is soft-deleted exactly as an owner's gallery
 * delete would be, with a `gallery.delete` outbox row, so the existing purge (KV tombstone, R2
 * originals/derivatives/archives, media `deleted`) and its backstop sweep remove the photos.
 * Without this nothing ever removed the objects of drafts that were never published.
 *
 * Runs on the 15-minute reconcile tick, a bounded number of batches per run; the remaining
 * backlog is picked up next tick. Idempotent: the repository only selects live drafts.
 */
export const GUEST_EXPIRY_BATCH = 100;
export const GUEST_EXPIRY_MAX_BATCHES = 20;

export interface GuestExpiryDeps {
  repo: GuestDraftExpiryRepository;
  log: Logger;
  now?: () => number;
  batch?: number;
  maxBatches?: number;
}

export interface GuestExpiryResult {
  expired: number;
  batches: number;
}

export async function sweepExpiredGuestDrafts(deps: GuestExpiryDeps): Promise<GuestExpiryResult> {
  const batch = deps.batch ?? GUEST_EXPIRY_BATCH;
  const maxBatches = deps.maxBatches ?? GUEST_EXPIRY_MAX_BATCHES;
  const now = new Date((deps.now ?? Date.now)());
  const result: GuestExpiryResult = { expired: 0, batches: 0 };
  while (result.batches < maxBatches) {
    const ids = await deps.repo.expireGuestDrafts(now, batch);
    result.batches++;
    result.expired += ids.length;
    if (ids.length < batch) break;
  }
  if (result.expired > 0) deps.log.info('expired guest drafts', { ...result });
  return result;
}
