import type { TransitionTable } from './state-machine';

export const ARCHIVE_STATUSES = [
  'requested',
  'queued',
  'running',
  'ready',
  'failed',
  'expired',
  'deleted',
] as const;
export type ArchiveStatus = (typeof ARCHIVE_STATUSES)[number];

export const ARCHIVE_TRANSITIONS: TransitionTable<ArchiveStatus> = {
  requested: ['queued', 'failed'],
  queued: ['running', 'failed'],
  running: ['ready', 'failed'],
  ready: ['expired', 'deleted'],
  failed: ['queued', 'deleted'],
  expired: ['deleted'],
  deleted: [],
};
