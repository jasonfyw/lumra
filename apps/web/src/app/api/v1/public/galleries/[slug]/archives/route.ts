import { createArchiveRequestSchema, type CreateArchiveResponse } from '@lumra/contracts';
import { ok, parseJsonBody } from '@/lib/api';
import { archiveSessionSetCookies, hashGallerySessionToken } from '@/lib/gallery-session';
import { assertSameOrigin } from '@/lib/origin';
import { hashClientIp } from '@/lib/rate-limit';
import { withRoute } from '@/lib/route';
import { createArchive } from '@/server/archives';
import {
  PRIVATE_NO_STORE,
  gallerySessionToken,
  publicRequestContext,
} from '@/server/public-context';
import { scheduleRelayKick } from '@/server/upload-context';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ slug: string }>;
}

/**
 * `POST /api/v1/public/galleries/{slug}/archives` `{mediaIds?}` (PRD §10, FR-D02/D03, T24).
 * Permitted viewers only (published, unexpired, unlocked when passworded); rate limited per IP.
 * Returns a new or reused archive job: 201 when a build was queued, 200 when an existing job
 * for the same content was returned. For a passworded gallery the session cookie is also set on
 * the job's progress page and status API paths, which re-check it on every read (T25).
 */
export const POST = withRoute<Context>(
  'POST /api/v1/public/galleries/[slug]/archives',
  async (request, scope, context) => {
    assertSameOrigin(request);
    const { slug } = await context.params;
    const { db } = await publicRequestContext(request, scope, 'publicArchiveCreate');
    const body = await parseJsonBody(request, createArchiveRequestSchema);
    const sessionToken = await gallerySessionToken();
    const requesterHash = sessionToken
      ? `session:${await hashGallerySessionToken(sessionToken)}`
      : `ip:${await hashClientIp(request)}`;

    const { response, sessionExpiresAt } = await createArchive(db, slug, body, {
      sessionToken,
      requesterHash,
      requestId: scope.requestId,
      log: scope.log,
    });
    if (!response.reused) scheduleRelayKick(scope.log, scope.requestId);

    const res = ok<CreateArchiveResponse>(response, scope.requestId, {
      status: response.reused ? 200 : 201,
      headers: PRIVATE_NO_STORE,
    });
    if (sessionToken && sessionExpiresAt) {
      const secure = process.env.NODE_ENV === 'production';
      for (const cookie of archiveSessionSetCookies(
        response.jobId,
        sessionToken,
        sessionExpiresAt,
        secure,
      )) {
        res.headers.append('Set-Cookie', cookie);
      }
    }
    return res;
  },
);
