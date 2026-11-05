import type { CreateGuestDraftResponse } from '@lumra/contracts';
import { getActiveGuestSession } from '@/lib/actor';
import { ok } from '@/lib/api';
import { getDb } from '@/lib/db';
import { requireEnv } from '@/lib/env';
import {
  GUEST_COOKIE_NAME,
  generateGuestCapability,
  guestCookieOptions,
  hashGuestCapability,
} from '@/lib/guest-capability';
import { assertSameOrigin } from '@/lib/origin';
import { clientIp, enforceRateLimit, hashClientIp } from '@/lib/rate-limit';
import { withRoute } from '@/lib/route';
import { createGuestDraft, findGuestDraftGallery } from '@/server/guest-drafts';
import { NO_STORE } from '@/server/upload-context';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/v1/guest/drafts` (FR-A01, FR-A03, FR-A05): creates a guest session + draft gallery
 * and sets the HttpOnly capability cookie. A browser that already holds a live draft gets that
 * draft back (200) instead of a new one. Creation is rate limited per (hashed) client IP, with
 * an optional Turnstile challenge above the soft threshold.
 */
export const POST = withRoute('POST /api/v1/guest/drafts', async (request, { requestId, log }) => {
  assertSameOrigin(request);
  const pepper = requireEnv('GUEST_CAPABILITY_PEPPER');
  const db = getDb();

  const existing = await getActiveGuestSession();
  if (existing) {
    const gallery = await findGuestDraftGallery(db, existing.guestSessionId);
    if (gallery) {
      return ok<CreateGuestDraftResponse>(
        { galleryId: gallery.id, draftExpiresAt: existing.expiresAt.toISOString() },
        requestId,
        { headers: NO_STORE },
      );
    }
  }

  await enforceRateLimit(
    request,
    'guestDraftCreate',
    { kind: 'ip', ip: clientIp(request.headers) },
    {
      db,
      log,
    },
  );

  const capability = generateGuestCapability();
  const draft = await createGuestDraft(db, {
    capabilityHash: await hashGuestCapability(capability, pepper),
    rateKeyHash: await hashClientIp(request),
  });
  log.info('guest draft created', { galleryId: draft.galleryId });

  const response = ok<CreateGuestDraftResponse>(
    { galleryId: draft.galleryId, draftExpiresAt: draft.expiresAt.toISOString() },
    requestId,
    { status: 201, headers: NO_STORE },
  );
  response.cookies.set(
    GUEST_COOKIE_NAME,
    capability,
    guestCookieOptions(draft.expiresAt, process.env.NODE_ENV === 'production'),
  );
  return response;
});
