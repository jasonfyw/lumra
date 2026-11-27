import { bulkDeleteMediaRequestSchema } from '@lumra/contracts';
import { ok } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { editorRequestContext, NO_STORE, readJsonBody } from '@/server/editor-context';
import { bulkDeleteMedia } from '@/server/gallery-editor';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/v1/galleries/{id}/media/bulk-delete`: `{mediaIds}` -> items marked `deleting`, via
 * the same per-item logic as the single delete. Owner-only; all or none.
 */
export const POST = withRoute<Context>(
  'POST /api/v1/galleries/[id]/media/bulk-delete',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { userId, deps } = await editorRequestContext(request, scope);
    const { mediaIds } = await readJsonBody(request, bulkDeleteMediaRequestSchema);
    return ok(await bulkDeleteMedia(deps, userId, id, mediaIds), scope.requestId, {
      headers: NO_STORE,
    });
  },
);
