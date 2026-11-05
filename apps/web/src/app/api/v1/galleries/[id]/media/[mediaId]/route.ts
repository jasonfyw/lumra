import { ok } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { editorRequestContext, NO_STORE } from '@/server/editor-context';
import { deleteMedia } from '@/server/gallery-editor';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string; mediaId: string }>;
}

/** `DELETE /api/v1/galleries/{id}/media/{mediaId}` (T15): revoke the item + enqueue cleanup. */
export const DELETE = withRoute<Context>(
  'DELETE /api/v1/galleries/[id]/media/[mediaId]',
  async (request, scope, context) => {
    const { id, mediaId } = await context.params;
    const { userId, deps } = await editorRequestContext(request, scope);
    return ok(await deleteMedia(deps, userId, id, mediaId), scope.requestId, {
      headers: NO_STORE,
    });
  },
);
