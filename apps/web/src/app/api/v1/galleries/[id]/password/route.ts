import { setGalleryPasswordRequestSchema } from '@lumra/contracts';
import { ok } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { editorRequestContext, NO_STORE, readJsonBody } from '@/server/editor-context';
import { setGalleryPassword } from '@/server/gallery-editor';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `PUT /api/v1/galleries/{id}/password` (T19, FR-G04): `{password: string | null}` sets,
 * changes or removes the password and bumps `access_version` (revokes unlocked sessions and
 * outstanding media tokens).
 */
export const PUT = withRoute<Context>(
  'PUT /api/v1/galleries/[id]/password',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { userId, deps } = await editorRequestContext(request, scope);
    const { password } = await readJsonBody(request, setGalleryPasswordRequestSchema);
    return ok(await setGalleryPassword(deps, userId, id, password), scope.requestId, {
      headers: NO_STORE,
    });
  },
);
