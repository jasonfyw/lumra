import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_TRANSITIONS,
  GALLERY_TRANSITIONS,
  InvalidTransitionError,
  MEDIA_TRANSITIONS,
  assertTransition,
  checkGuestReservation,
  galleryAccessState,
} from './index';

describe('state machines', () => {
  it('treats deleted as terminal everywhere', () => {
    expect(GALLERY_TRANSITIONS.deleted).toEqual([]);
    expect(MEDIA_TRANSITIONS.deleted).toEqual([]);
    expect(ARCHIVE_TRANSITIONS.deleted).toEqual([]);
  });

  it('rejects skipping media states', () => {
    expect(() => assertTransition('media', MEDIA_TRANSITIONS, 'reserved', 'ready')).toThrow(
      InvalidTransitionError,
    );
  });
});

describe('galleryAccessState', () => {
  const now = new Date('2026-10-21T12:00:00Z');

  it('computes expiry from the timestamp rather than persisted state', () => {
    expect(
      galleryAccessState({ status: 'published', expiresAt: new Date('2026-10-21T11:59:59Z') }, now),
    ).toBe('expired');
    expect(galleryAccessState({ status: 'published', expiresAt: null }, now)).toBe('published');
    expect(galleryAccessState({ status: 'deleted', expiresAt: null }, now)).toBe('deleted');
  });
});

describe('checkGuestReservation', () => {
  it('allows the 20th file but not the 21st', () => {
    expect(checkGuestReservation({ reservedFileCount: 19, reservedBytes: 0 }, 1)).toEqual({
      allowed: true,
    });
    expect(checkGuestReservation({ reservedFileCount: 20, reservedBytes: 0 }, 1)).toEqual({
      allowed: false,
      reason: 'file_count',
    });
  });

  it('enforces the 250 MB total, whichever limit is hit first', () => {
    expect(checkGuestReservation({ reservedFileCount: 1, reservedBytes: 249_999_999 }, 2)).toEqual({
      allowed: false,
      reason: 'bytes',
    });
    expect(checkGuestReservation({ reservedFileCount: 1, reservedBytes: 249_999_999 }, 1)).toEqual({
      allowed: true,
    });
  });
});
