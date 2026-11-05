import type { UploadStateResponse } from '@lumra/contracts';
import { ok } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { NO_STORE, uploadRequestContext } from '@/server/upload-context';
import { getUploadState } from '@/server/uploads';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

/** `GET /api/v1/uploads/{id}`: state + server-side part list for resume (no credentials). */
export const GET = withRoute<Context>(
  'GET /api/v1/uploads/[id]',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { principals, deps } = await uploadRequestContext(request, scope, 'uploadMutate');
    const state = await getUploadState(deps, principals, id);
    return ok<UploadStateResponse>(state, scope.requestId, { headers: NO_STORE });
  },
  { quiet: true },
);
