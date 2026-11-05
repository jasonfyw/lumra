import { healthPayload } from '@lumra/observability';
import { ok } from '@/lib/api';
import { withRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/**
 * Sanitized liveness probe: status, service name and the deploy's short commit SHA when
 * Vercel provides one. Never config, dependency versions, env names or secrets.
 */
export const GET = withRoute(
  'GET /api/health',
  (_request, { requestId }) =>
    ok(healthPayload('web', process.env.VERCEL_GIT_COMMIT_SHA), requestId, {
      headers: { 'Cache-Control': 'no-store' },
    }),
  { quiet: true },
);
