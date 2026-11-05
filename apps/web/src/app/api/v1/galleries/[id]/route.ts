import { updateGalleryRequestSchema } from '@lumra/contracts';
import { ok } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { editorRequestContext, NO_STORE, readJsonBody } from '@/server/editor-context';
import { deleteGallery, getGalleryDetail, updateGallery } from '@/server/gallery-editor';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

/** Owner detail incl. every item's internal status (T15). */
export const GET = withRoute<Context>(
  'GET /api/v1/galleries/[id]',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { userId, deps } = await editorRequestContext(request, scope);
    return ok(await getGalleryDetail(deps, userId, id), scope.requestId, { headers: NO_STORE });
  },
);

/** `{title?, coverMediaId?, expiresAt?}` → updated detail (T15, T19 expiry). */
export const PATCH = withRoute<Context>(
  'PATCH /api/v1/galleries/[id]',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { userId, deps } = await editorRequestContext(request, scope);
    const input = await readJsonBody(request, updateGalleryRequestSchema);
    return ok(await updateGallery(deps, userId, id, input), scope.requestId, {
      headers: NO_STORE,
    });
  },
);

/** Immediate deletion (FR-G06): inaccessible before the response returns; purge is async. */
export const DELETE = withRoute<Context>(
  'DELETE /api/v1/galleries/[id]',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { userId, deps } = await editorRequestContext(request, scope);
    return ok(await deleteGallery(deps, userId, id), scope.requestId, { headers: NO_STORE });
  },
);
