import type { MediaStatus, PublicMediaStatus } from '@lumra/contracts';
import type { TransitionTable } from './state-machine';

/** PRD §7: any non-deleted state may move to deleting; failed media can be retried. */
export const MEDIA_TRANSITIONS: TransitionTable<MediaStatus> = {
  reserved: ['uploading', 'failed', 'deleting'],
  uploading: ['uploaded', 'failed', 'deleting'],
  uploaded: ['processing', 'deleting'],
  processing: ['ready', 'failed', 'deleting'],
  ready: ['deleting'],
  failed: ['uploading', 'processing', 'deleting'],
  deleting: ['deleted'],
  deleted: [],
};

/** Placeholder tiles are non-downloadable; only `ready` items are viewable/downloadable. */
export function isMediaViewable(status: MediaStatus): boolean {
  return status === 'ready';
}

/**
 * Recipient-facing status (PRD §4 "Upload UI state"): in-flight states read as `pending`, and
 * failures read as a neutral `unavailable` — recipients never see internal pipeline states.
 * Deleting/deleted items are not listed at all (callers filter them out).
 */
export function toPublicMediaStatus(status: MediaStatus): PublicMediaStatus {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'reserved':
    case 'uploading':
    case 'uploaded':
    case 'processing':
      return 'pending';
    default:
      return 'unavailable';
  }
}
