import { describe, expect, it } from 'vitest';
import { MEDIA_STATUSES } from '@lumra/contracts';
import {
  DELETION_SWEEP_GRACE_MS,
  deletionSweepCutoff,
  mediaPurgeDecision,
  purgedMediaStatus,
} from './purge';

describe('mediaPurgeDecision', () => {
  it('purges soft-deleted media in any non-deleted state', () => {
    for (const status of MEDIA_STATUSES.filter((s) => s !== 'deleted')) {
      expect(mediaPurgeDecision({ status, mediaDeleted: true, galleryDeleted: false })).toBe(
        'purge',
      );
      expect(mediaPurgeDecision({ status, mediaDeleted: false, galleryDeleted: true })).toBe(
        'purge',
      );
    }
  });

  it('never purges live media of a live gallery', () => {
    for (const status of MEDIA_STATUSES.filter((s) => s !== 'deleted')) {
      expect(mediaPurgeDecision({ status, mediaDeleted: false, galleryDeleted: false })).toBe(
        'live',
      );
    }
  });

  it('treats already-deleted rows as done (idempotent)', () => {
    expect(
      mediaPurgeDecision({ status: 'deleted', mediaDeleted: true, galleryDeleted: true }),
    ).toBe('already_purged');
  });
});

describe('purgedMediaStatus', () => {
  it('ends every purgeable state in deleted', () => {
    for (const status of MEDIA_STATUSES.filter((s) => s !== 'deleted')) {
      expect(purgedMediaStatus(status)).toBe('deleted');
    }
  });

  it('rejects purging an already deleted row', () => {
    expect(() => purgedMediaStatus('deleted')).toThrow();
  });
});

describe('deletionSweepCutoff', () => {
  it('defaults to a one-hour grace', () => {
    const now = new Date('2026-11-11T12:00:00Z');
    expect(DELETION_SWEEP_GRACE_MS).toBe(3_600_000);
    expect(deletionSweepCutoff(now).toISOString()).toBe('2026-11-11T11:00:00.000Z');
    expect(deletionSweepCutoff(now, 0).getTime()).toBe(now.getTime());
  });
});
