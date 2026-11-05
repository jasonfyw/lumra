import { describe, expect, it } from 'vitest';
import { decideClaim, type ClaimGalleryRow, type ClaimGuestSessionRow } from './claim';

const now = new Date('2026-11-05T12:00:00Z');
const USER = 'user-a';
const session: ClaimGuestSessionRow = {
  id: 'gs-1',
  expiresAt: new Date('2026-11-06T00:00:00Z'),
  claimedByUserId: null,
  claimedAt: null,
};
const draft: ClaimGalleryRow = {
  ownerId: null,
  guestSessionId: 'gs-1',
  claimedAt: null,
  deletedAt: null,
};

describe('decideClaim', () => {
  it('claims a live guest draft proven by its own capability', () => {
    expect(decideClaim({ userId: USER, gallery: draft, guestSession: session, now })).toEqual({
      kind: 'claim',
    });
  });

  it('never claims by gallery id alone (no guest cookie)', () => {
    expect(decideClaim({ userId: USER, gallery: draft, guestSession: null, now })).toMatchObject({
      kind: 'not_found',
      reason: 'no_capability',
    });
  });

  it('rejects a capability for a different guest session', () => {
    const other = { ...session, id: 'gs-2' };
    expect(decideClaim({ userId: USER, gallery: draft, guestSession: other, now })).toMatchObject({
      kind: 'not_found',
      reason: 'capability_mismatch',
    });
  });

  it('rejects expired or already-claimed sessions, deleted and foreign galleries', () => {
    const expired = { ...session, expiresAt: now };
    expect(decideClaim({ userId: USER, gallery: draft, guestSession: expired, now }).kind).toBe(
      'not_found',
    );
    const claimed = { ...session, claimedAt: now, claimedByUserId: 'user-b' };
    expect(decideClaim({ userId: USER, gallery: draft, guestSession: claimed, now }).kind).toBe(
      'not_found',
    );
    expect(
      decideClaim({
        userId: USER,
        gallery: { ...draft, deletedAt: now },
        guestSession: session,
        now,
      }).kind,
    ).toBe('not_found');
    const foreign = { ...draft, ownerId: 'user-b', claimedAt: now };
    expect(
      decideClaim({ userId: USER, gallery: foreign, guestSession: session, now }),
    ).toMatchObject({ kind: 'not_found', reason: 'owned_by_other' });
    expect(decideClaim({ userId: USER, gallery: null, guestSession: session, now }).kind).toBe(
      'not_found',
    );
  });

  it('is idempotent for the user who already claimed it, even without the cookie', () => {
    const mine = { ...draft, ownerId: USER, claimedAt: now };
    expect(decideClaim({ userId: USER, gallery: mine, guestSession: null, now })).toEqual({
      kind: 'already_claimed',
      claimedAt: now,
    });
  });

  it('does not treat a gallery created directly by the user as a claim', () => {
    const created = { ...draft, ownerId: USER, guestSessionId: null };
    expect(decideClaim({ userId: USER, gallery: created, guestSession: session, now }).kind).toBe(
      'not_found',
    );
  });
});
