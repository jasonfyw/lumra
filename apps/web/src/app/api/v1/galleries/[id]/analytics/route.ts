import type { GalleryAnalytics } from '@lumra/contracts';
import { ok } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { editorRequestContext, NO_STORE } from '@/server/editor-context';
import { getGalleryAnalytics } from '@/server/gallery-analytics';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

/** `GET /api/v1/galleries/{id}/analytics`: the owner's aggregate counters (FR-N02, T26). */
export const GET = withRoute<Context>(
  'GET /api/v1/galleries/[id]/analytics',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { userId, deps } = await editorRequestContext(request, scope);
    return ok<GalleryAnalytics>(await getGalleryAnalytics(deps.db, userId, id), scope.requestId, {
      headers: NO_STORE,
    });
  },
  { quiet: true },
);
