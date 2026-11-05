import {
  createGalleryRequestSchema,
  decodeKeysetCursor,
  galleryListQuerySchema,
  idempotencyKeySchema,
} from '@lumra/contracts';
import { getAuthenticatedUser } from '@/lib/actor';
import { fail, ok } from '@/lib/api';
import { serverEnv } from '@/lib/env';
import { createGalleryForOwner, listGalleriesForOwner } from '@/lib/galleries';
import {
  crossOriginError,
  NO_STORE,
  parseJsonBody,
  UNAUTHENTICATED,
  validation,
} from '@/lib/request-guards';
import { withRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/** Owner gallery list (T08, FR-N01): `?cursor&limit` → `{items, nextCursor}`. */
export const GET = withRoute('GET /api/v1/galleries', async (request, { requestId }) => {
  const user = await getAuthenticatedUser();
  if (!user) return fail(UNAUTHENTICATED, requestId, { headers: NO_STORE });

  const params = new URL(request.url).searchParams;
  const query = galleryListQuerySchema.safeParse({
    cursor: params.get('cursor') ?? undefined,
    limit: params.get('limit') ?? undefined,
  });
  if (!query.success) {
    return fail(validation('limit must be an integer between 1 and 100.'), requestId);
  }
  const cursor = query.data.cursor ? decodeKeysetCursor(query.data.cursor) : null;
  if (query.data.cursor && !cursor) return fail(validation('Invalid cursor.'), requestId);

  const page = await listGalleriesForOwner(user.userId, { limit: query.data.limit, cursor });
  return ok(page, requestId, { headers: NO_STORE });
});

/** Create a gallery (T08, FR-G01/FR-G07). Honours `Idempotency-Key` (PRD §10). */
export const POST = withRoute('POST /api/v1/galleries', async (request, { requestId, log }) => {
  const csrf = crossOriginError(request, serverEnv().NEXT_PUBLIC_APP_URL);
  if (csrf) return fail(csrf, requestId);

  const user = await getAuthenticatedUser();
  if (!user) return fail(UNAUTHENTICATED, requestId, { headers: NO_STORE });

  const rawKey = request.headers.get('idempotency-key');
  const key = rawKey === null ? undefined : idempotencyKeySchema.safeParse(rawKey);
  if (key && !key.success) {
    return fail(validation('Idempotency-Key must be 8–128 URL-safe characters.'), requestId);
  }

  const body = await parseJsonBody(request, createGalleryRequestSchema);
  if (!body.ok) return fail(body.error, requestId);

  const result = await createGalleryForOwner(user.userId, {
    title: body.data.title,
    idempotencyKey: key?.data,
  });

  switch (result.kind) {
    case 'created':
      log.info('gallery created', { galleryId: result.gallery.id });
      return ok(result.gallery, requestId, { status: 201, headers: NO_STORE });
    case 'replayed':
      return ok(result.gallery, requestId, {
        status: 200,
        headers: { ...NO_STORE, 'Idempotent-Replayed': 'true' },
      });
    case 'conflict':
      return fail(
        {
          code: 'conflict',
          message: 'This Idempotency-Key was already used for another request.',
          retryable: false,
        },
        requestId,
      );
    case 'quota_exceeded':
      return fail(
        {
          code: 'quota_exceeded',
          message: 'Your plan’s gallery limit is reached. Delete a gallery or upgrade to Pro.',
          retryable: false,
          details: { reason: 'free_gallery_cap', maxActiveGalleries: result.maxActiveGalleries },
        },
        requestId,
      );
  }
});
