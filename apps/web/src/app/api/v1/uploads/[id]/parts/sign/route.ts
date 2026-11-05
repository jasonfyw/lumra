import { signPartsRequestSchema, type SignPartsResponse } from '@lumra/contracts';
import { ok, parseJsonBody } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { NO_STORE, uploadRequestContext } from '@/server/upload-context';
import { signUploadParts } from '@/server/uploads';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/v1/uploads/{id}/parts/sign`: presigned PUT URLs for the requested parts. The URLs are
 * bearer credentials — they are returned to the caller only and never logged.
 */
export const POST = withRoute<Context>(
  'POST /api/v1/uploads/[id]/parts/sign',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { principals, deps } = await uploadRequestContext(request, scope, 'uploadSign');
    const input = await parseJsonBody(request, signPartsRequestSchema);
    const signed = await signUploadParts(deps, principals, id, input.partNumbers);
    return ok<SignPartsResponse>(signed, scope.requestId, { headers: NO_STORE });
  },
);
