import type { ArchiveStatusResponse } from '@lumra/contracts';
import { ok } from '@/lib/api';
import { withRoute } from '@/lib/route';
import { loadArchiveStatus } from '@/server/archive-status';
import {
  PRIVATE_NO_STORE,
  gallerySessionToken,
  mintDeps,
  publicRequestContext,
} from '@/server/public-context';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ jobId: string }>;
}

/**
 * `GET /api/v1/public/archives/{jobId}` (PRD §10, T25): progress and, once ready, per-part
 * gateway download URLs (≤ 5 min; poll again to refresh). Re-checks gallery access on every
 * read (published, unexpired, current `access_version`, password session). Rate limited per IP;
 * `quiet` so polling doesn't flood the logs, and URLs are never logged.
 */
export const GET = withRoute<Context>(
  'GET /api/v1/public/archives/[jobId]',
  async (request, scope, context) => {
    const { jobId } = await context.params;
    const { db } = await publicRequestContext(request, scope, 'publicArchiveRead');
    const data = await loadArchiveStatus(db, jobId, mintDeps(), {
      sessionToken: await gallerySessionToken(),
    });
    return ok<ArchiveStatusResponse>(data, scope.requestId, { headers: PRIVATE_NO_STORE });
  },
  { quiet: true },
);
