/**
 * Guest draft claim rules (FR-A03, FR-A04, ADR-005, T07). Pure: the caller loads and locks the
 * rows inside one transaction, asks for a decision, then applies it.
 *
 * A claim needs BOTH a verified user AND the guest capability of the session that owns the
 * draft. A gallery ID alone is never enough, so every "you may not" outcome is reported as
 * `not_found` to conceal whether the draft exists.
 */
export interface ClaimGalleryRow {
  ownerId: string | null;
  guestSessionId: string | null;
  claimedAt: Date | null;
  deletedAt: Date | null;
}

export interface ClaimGuestSessionRow {
  id: string;
  expiresAt: Date;
  claimedByUserId: string | null;
  claimedAt: Date | null;
}

export type ClaimDecision =
  | { kind: 'claim' }
  | { kind: 'already_claimed'; claimedAt: Date }
  | {
      kind: 'not_found';
      /** For logs only; never sent to the client. */
      reason:
        | 'missing'
        | 'deleted'
        | 'owned_by_other'
        | 'no_capability'
        | 'capability_mismatch'
        | 'session_expired'
        | 'session_claimed';
    };

export function decideClaim(input: {
  userId: string;
  gallery: ClaimGalleryRow | null;
  /** The session proven by the request's guest cookie (locked), or null without a cookie. */
  guestSession: ClaimGuestSessionRow | null;
  now: Date;
}): ClaimDecision {
  const { userId, gallery, guestSession, now } = input;
  if (!gallery) return { kind: 'not_found', reason: 'missing' };
  if (gallery.deletedAt) return { kind: 'not_found', reason: 'deleted' };

  // Idempotent replay: this user already owns it through an earlier claim. Revealing that a user
  // owns their own gallery leaks nothing, so no cookie is needed here.
  if (gallery.ownerId === userId && gallery.claimedAt) {
    return { kind: 'already_claimed', claimedAt: gallery.claimedAt };
  }
  if (gallery.ownerId !== null) return { kind: 'not_found', reason: 'owned_by_other' };

  if (!guestSession) return { kind: 'not_found', reason: 'no_capability' };
  if (gallery.guestSessionId !== guestSession.id) {
    return { kind: 'not_found', reason: 'capability_mismatch' };
  }
  if (guestSession.claimedAt || guestSession.claimedByUserId) {
    return { kind: 'not_found', reason: 'session_claimed' };
  }
  if (guestSession.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'not_found', reason: 'session_expired' };
  }
  return { kind: 'claim' };
}
