import { completeUploadRequestSchema, type CompleteUploadResponse } from '@lumra/contracts';
import { ok, parseJsonBody } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { NO_STORE, uploadRequestContext } from '@/server/upload-context';
import { completeUpload } from '@/server/uploads';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

/** `POST /api/v1/uploads/{id}/complete`: verify, finalise and enqueue processing (idempotent). */
export const POST = withRoute<Context>(
  'POST /api/v1/uploads/[id]/complete',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { principals, deps } = await uploadRequestContext(request, scope, 'uploadMutate');
    const input = await parseJsonBody(request, completeUploadRequestSchema);
    const result = await completeUpload(deps, principals, id, input);
    return ok<CompleteUploadResponse>(result, scope.requestId, { headers: NO_STORE });
  },
);
