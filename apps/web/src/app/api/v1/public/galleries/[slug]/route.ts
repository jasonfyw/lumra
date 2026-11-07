import type { PublicGalleryLookup } from '@lumra/contracts';
import { ok } from '@/lib/api';
import { withRoute } from '@/lib/route';
import {
  PRIVATE_NO_STORE,
  gallerySessionToken,
  mintDeps,
  publicRequestContext,
} from '@/server/public-context';
import { loadPublicGallery } from '@/server/public-gallery';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ slug: string }>;
}

/**
 * `GET /api/v1/public/galleries/{slug}` (FR-V01, T16): published, unexpired galleries only
 * (unknown/draft/deleted → 404, expired → 410 `gallery_expired`). Password-protected galleries
 * return `{passwordRequired: true}` until a valid gallery session cookie is present.
 *
 * `?urls=0` skips URL minting: the client's pending-item poll only needs statuses, and mints
 * URLs for newly ready tiles through `media-tokens` as they become visible.
 */
export const GET = withRoute<Context>(
  'GET /api/v1/public/galleries/[slug]',
  async (request, scope, context) => {
    const { slug } = await context.params;
    const { db } = await publicRequestContext(request, scope, 'publicGalleryRead');
    const mintUrls = new URL(request.url).searchParams.get('urls') !== '0';
    const data = await loadPublicGallery(db, slug, mintUrls ? mintDeps() : null, {
      sessionToken: await gallerySessionToken(),
      mintUrls,
    });
    return ok<PublicGalleryLookup>(data, scope.requestId, { headers: PRIVATE_NO_STORE });
  },
  { quiet: true },
);
