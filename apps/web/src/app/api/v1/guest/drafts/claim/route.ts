import { claimGuestDraftRequestSchema, type ClaimGuestDraftResponse } from '@lumra/contracts';
import { getActiveGuestSession, getAuthenticatedUser } from '@/lib/actor';
import { fail, ok } from '@/lib/api';
import { serverEnv } from '@/lib/env';
import { claimGuestDraft } from '@/lib/galleries';
import { GUEST_COOKIE_NAME } from '@/lib/guest-capability';
import {
  crossOriginError,
  NO_STORE,
  NOT_FOUND,
  parseJsonBody,
  UNAUTHENTICATED,
} from '@/lib/request-guards';
import { withRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/**
 * Claim a guest draft for the signed-in user (T07, FR-A03/A04, ADR-005).
 * Requires BOTH a verified Supabase user AND this browser's guest capability cookie for the
 * session that owns the draft. Without the cookie the draft is reported as not found — a
 * gallery id alone never transfers ownership (PRD §11).
 */
export const POST = withRoute(
  'POST /api/v1/guest/drafts/claim',
  async (request, { requestId, log }) => {
    const csrf = crossOriginError(request, serverEnv().NEXT_PUBLIC_APP_URL);
    if (csrf) return fail(csrf, requestId);

    const user = await getAuthenticatedUser();
    if (!user) return fail(UNAUTHENTICATED, requestId, { headers: NO_STORE });

    const body = await parseJsonBody(request, claimGuestDraftRequestSchema);
    if (!body.ok) return fail(body.error, requestId);

    const guest = await getActiveGuestSession();
    const result = await claimGuestDraft({
      userId: user.userId,
      galleryId: body.data.galleryId,
      guestSessionId: guest?.guestSessionId ?? null,
    });

    switch (result.kind) {
      case 'not_found':
        // The reason is for operators only; the client always sees a concealed 404.
        log.info('guest claim refused', { reason: result.reason, hasGuestCookie: !!guest });
        return fail(NOT_FOUND, requestId, { headers: NO_STORE });
      case 'quota_exceeded':
        return fail(
          {
            code: 'quota_exceeded',
            message:
              'Your plan’s gallery limit is reached. Delete a gallery or upgrade to Pro to keep this draft.',
            retryable: false,
            details: { reason: 'free_gallery_cap', maxActiveGalleries: result.maxActiveGalleries },
          },
          requestId,
          { headers: NO_STORE },
        );
      case 'claimed':
      case 'already_claimed': {
        if (result.kind === 'claimed') {
          log.info('guest draft claimed', {
            galleryId: body.data.galleryId,
            pendingUploads: result.pendingUploads,
          });
        }
        const data: ClaimGuestDraftResponse = {
          galleryId: body.data.galleryId,
          claimedAt: result.claimedAt.toISOString(),
          alreadyClaimed: result.kind === 'already_claimed',
          pendingUploads: result.pendingUploads,
        };
        const response = ok(data, requestId, { headers: NO_STORE });
        // The capability is spent once its session is claimed; drop it from this browser.
        if (result.kind === 'claimed') {
          response.cookies.set(GUEST_COOKIE_NAME, '', {
            httpOnly: true,
            secure: new URL(request.url).protocol === 'https:',
            sameSite: 'lax',
            path: '/',
            maxAge: 0,
          });
        }
        return response;
      }
    }
  },
);
