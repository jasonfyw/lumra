import { reorderMediaRequestSchema } from '@lumra/contracts';
import { ok } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { editorRequestContext, NO_STORE, readJsonBody } from '@/server/editor-context';
import { reorderMedia } from '@/server/gallery-editor';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

/** `PATCH /api/v1/galleries/{id}/media/order` (T15, FR-G03): `{orderedIds}` → new revision. */
export const PATCH = withRoute<Context>(
  'PATCH /api/v1/galleries/[id]/media/order',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { userId, deps } = await editorRequestContext(request, scope);
    const { orderedIds } = await readJsonBody(request, reorderMediaRequestSchema);
    return ok(await reorderMedia(deps, userId, id, orderedIds), scope.requestId, {
      headers: NO_STORE,
    });
  },
);
