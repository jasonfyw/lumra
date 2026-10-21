import type { MediaStatus } from '@lumra/contracts';
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
