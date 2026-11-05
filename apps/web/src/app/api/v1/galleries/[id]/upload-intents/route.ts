import { uploadIntentRequestSchema, type UploadIntentResponse } from '@lumra/contracts';
import { ok, parseJsonBody, validationError } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { NO_STORE, uploadRequestContext } from '@/server/upload-context';
import { createUploadIntent } from '@/server/uploads';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/v1/galleries/{id}/upload-intents` (owner or the draft's guest): reserves quota and
 * returns the upload plan. Idempotent by `clientId`; an `Idempotency-Key` header, if sent, must
 * equal `clientId`. 201 for a new intent, 200 for a replay.
 */
export const POST = withRoute<Context>(
  'POST /api/v1/galleries/[id]/upload-intents',
  async (request, scope, context) => {
    const { id } = await context.params;
    const { principals, deps } = await uploadRequestContext(request, scope, 'uploadIntent');
    const input = await parseJsonBody(request, uploadIntentRequestSchema);
    const idempotencyKey = request.headers.get('idempotency-key');
    if (idempotencyKey !== null && idempotencyKey !== input.clientId) {
      throw validationError({ 'Idempotency-Key': 'must equal clientId' });
    }
    const { intent, created } = await createUploadIntent(deps, principals, id, input);
    return ok<UploadIntentResponse>(intent, scope.requestId, {
      status: created ? 201 : 200,
      headers: NO_STORE,
    });
  },
);
