import { mediaTokensRequestSchema, type MediaTokensResponse } from '@lumra/contracts';
import { getAuthenticatedUser } from '@/lib/actor';
import { ok, parseJsonBody } from '@/lib/api';
import { assertSameOrigin } from '@/lib/origin';
import { withRoute } from '@/lib/route';
import {
  PRIVATE_NO_STORE,
  gallerySessionToken,
  mintDeps,
  publicRequestContext,
} from '@/server/public-context';
import { trackGalleryEvent, visitorFromHeaders } from '@/server/gallery-analytics';
import { mintMediaTokens } from '@/server/public-gallery';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ slug: string }>;
}

/**
 * `POST /api/v1/public/galleries/{slug}/media-tokens` `{mediaIds, action}` (PRD §6.2, T20).
 * Permitted viewers only (published, unexpired, unlocked when passworded). Mints ≤ 5 min gateway
 * URLs carrying the gallery's current `access_version` for ready media of *this* gallery; any
 * other id is returned in `missing` and gets no token.
 */
export const POST = withRoute<Context>(
  'POST /api/v1/public/galleries/[slug]/media-tokens',
  async (request, scope, context) => {
    assertSameOrigin(request);
    const { slug } = await context.params;
    const { db } = await publicRequestContext(request, scope, 'publicMediaTokens');
    const body = await parseJsonBody(request, mediaTokensRequestSchema);
    const data = await mintMediaTokens(db, slug, mintDeps(), body, {
      sessionToken: await gallerySessionToken(),
    });
    if (body.action === 'original') {
      // A minted download URL is an initiated download (T22/T26); counted after the response.
      const mediaIds = data.items.filter((i) => i.downloadUrl).map((i) => i.id);
      if (mediaIds.length > 0) {
        const visitor = visitorFromHeaders(request.headers, getAuthenticatedUser());
        trackGalleryEvent(db, slug, { type: 'item_download', mediaIds }, visitor, {
          log: scope.log,
        });
      }
    }
    return ok<MediaTokensResponse>(data, scope.requestId, { headers: PRIVATE_NO_STORE });
  },
  { quiet: true },
);
