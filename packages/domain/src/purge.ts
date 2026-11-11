import type { MediaStatus } from '@lumra/contracts';
import { canTransition } from './state-machine';
import { MEDIA_TRANSITIONS } from './media';

/**
 * Physical deletion rules (FR-G06, T13). Deleting a photo or a gallery is a soft delete in
 * Postgres first (media `deleting` / gallery `deleted`, both with `deleted_at`); the worker then
 * removes the R2 objects and finally marks each media `deleted`. These rules decide what the
 * purge may touch, so a stray or replayed message can never remove a live photo's objects.
 */

export interface PurgeCandidate {
  status: MediaStatus;
  /** The media row itself is soft-deleted (`media.deleted_at` set). */
  mediaDeleted: boolean;
  /** Its gallery is soft-deleted (`galleries.deleted_at` set). */
  galleryDeleted: boolean;
}

/**
 * - `purge`: remove the original and every derivative, then mark the row `deleted`.
 * - `already_purged`: the row is `deleted`; nothing to do (idempotent redelivery).
 * - `live`: neither the media nor its gallery is deleted; refuse (never purge live media).
 */
export type PurgeDecision = 'purge' | 'already_purged' | 'live';

export function mediaPurgeDecision(candidate: PurgeCandidate): PurgeDecision {
  if (candidate.status === 'deleted') return 'already_purged';
  if (!candidate.mediaDeleted && !candidate.galleryDeleted) return 'live';
  // A gallery deletion implicitly moves every item through `deleting` (PRD §7: any non-deleted
  // state may move to deleting), so items of a deleted gallery are purged in whatever state.
  return 'purge';
}

/** The state the purge leaves a media row in, validated against the PRD §7 state machine. */
export function purgedMediaStatus(from: MediaStatus): MediaStatus {
  const viaDeleting = from === 'deleting' || canTransition(MEDIA_TRANSITIONS, from, 'deleting');
  if (!viaDeleting || !canTransition(MEDIA_TRANSITIONS, 'deleting', 'deleted')) {
    throw new Error(`media in state ${from} cannot be purged`);
  }
  return 'deleted';
}

/**
 * The backstop sweep only picks up deletions older than this: the queued `media.delete` /
 * `gallery.delete` job normally finishes within a minute, and the grace keeps the sweep from
 * racing it. Well inside the 24 h physical-deletion SLO even with several missed sweeps.
 */
export const DELETION_SWEEP_GRACE_MS = 60 * 60 * 1000;

export function deletionSweepCutoff(now: Date, graceMs = DELETION_SWEEP_GRACE_MS): Date {
  return new Date(now.getTime() - graceMs);
}
