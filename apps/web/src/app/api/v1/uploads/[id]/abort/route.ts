import type { AbortUploadResponse } from '@lumra/contracts';
import { ok } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { NO_STORE, uploadRequestContext } from '@/server/upload-context';
import { abortUpload } from '@/server/uploads';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

/** `POST /api/v1/uploads/{id}/abort`: idempotent cancel; releases the reservation. */
export const POST = withRoute<Context>(
  'POST /api/v1/uploads/[id]/abort',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { principals, deps } = await uploadRequestContext(request, scope, 'uploadMutate');
    const result = await abortUpload(deps, principals, id);
    return ok<AbortUploadResponse>(result, scope.requestId, { headers: NO_STORE });
  },
);
