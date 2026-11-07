import { publishGalleryRequestSchema } from '@lumra/contracts';
import { ok } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { editorRequestContext, NO_STORE, readJsonBody } from '@/server/editor-context';
import { publishGallery } from '@/server/gallery-editor';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/v1/galleries/{id}/publish` (T16, FR-G02): `{expiresAt?, password?}` →
 * `{slug, shareUrl, …}` immediately, whatever the items' readiness. Idempotent: replays return
 * 200 with `alreadyPublished: true`; the first publish returns 201.
 */
export const POST = withRoute<Context>(
  'POST /api/v1/galleries/[id]/publish',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { userId, deps } = await editorRequestContext(request, scope);
    const input = await readJsonBody(request, publishGalleryRequestSchema);
    const result = await publishGallery(deps, userId, id, input);
    return ok(result, scope.requestId, {
      status: result.alreadyPublished ? 200 : 201,
      headers: NO_STORE,
    });
  },
);
