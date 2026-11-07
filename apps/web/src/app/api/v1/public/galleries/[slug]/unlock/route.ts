import { unlockGalleryRequestSchema, type UnlockGalleryResponse } from '@lumra/contracts';
import { ok, parseJsonBody } from '@/lib/api';
import { gallerySessionSetCookies, generateGallerySessionToken } from '@/lib/gallery-session';
import { assertSameOrigin } from '@/lib/origin';
import { enforceRateLimit } from '@/lib/rate-limit';
import { withRoute } from '@/lib/route';
import { PRIVATE_NO_STORE, publicRequestContext } from '@/server/public-context';
import { unlockGallery } from '@/server/public-gallery';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ slug: string }>;
}

/**
 * `POST /api/v1/public/galleries/{slug}/unlock` `{password}` (FR-G04, T19). Every attempt counts
 * against a per-IP limit (Turnstile above the soft threshold when configured) and a per-gallery
 * limit, both before the Argon2id verification. On success a gallery session row (token hash
 * only, bound to the current `access_version`, 12 h) is created and the HttpOnly cookie set on
 * this gallery's page and API paths.
 */
export const POST = withRoute<Context>(
  'POST /api/v1/public/galleries/[slug]/unlock',
  async (request, scope, context) => {
    assertSameOrigin(request);
    const { slug } = await context.params;
    const { db } = await publicRequestContext(request, scope, 'galleryUnlock');
    const { password } = await parseJsonBody(request, unlockGalleryRequestSchema);

    const token = generateGallerySessionToken();
    const result = await unlockGallery(db, slug, password, token, {
      beforeVerify: (galleryId) =>
        enforceRateLimit(
          request,
          'galleryUnlockPerGallery',
          { kind: 'gallery', galleryId },
          { db, log: scope.log, challenge: null },
        ),
    });

    if (result.kind === 'no_password') {
      return ok<UnlockGalleryResponse>({ unlocked: true, expiresAt: null }, scope.requestId, {
        headers: PRIVATE_NO_STORE,
      });
    }
    scope.log.info('gallery unlocked', { galleryId: result.galleryId });
    const response = ok<UnlockGalleryResponse>(
      { unlocked: true, expiresAt: result.expiresAt.toISOString() },
      scope.requestId,
      { headers: PRIVATE_NO_STORE },
    );
    const secure = process.env.NODE_ENV === 'production';
    for (const cookie of gallerySessionSetCookies(slug, token, result.expiresAt, secure)) {
      response.headers.append('Set-Cookie', cookie);
    }
    return response;
  },
);
