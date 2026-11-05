import type { GuestDraftResponse } from '@lumra/contracts';
import { getActiveGuestSession } from '@/lib/actor';
import { notFoundError, ok } from '@/lib/api';
import { getDb } from '@/lib/db';
import { requireEnv } from '@/lib/env';
import { withRoute } from '@/lib/route';
import { loadGuestDraft } from '@/server/guest-drafts';
import { NO_STORE } from '@/server/upload-context';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/guest/drafts/current`: the draft proven by the capability cookie, with quota usage
 * and per-item media/upload states for resume. 404 when the cookie is missing, malformed,
 * expired or already claimed.
 */
export const GET = withRoute(
  'GET /api/v1/guest/drafts/current',
  async (_request, { requestId }) => {
    requireEnv('GUEST_CAPABILITY_PEPPER');
    const guest = await getActiveGuestSession();
    if (!guest) throw notFoundError('No active draft.');
    const draft = await loadGuestDraft(getDb(), guest.guestSessionId);
    if (!draft) throw notFoundError('No active draft.');
    return ok<GuestDraftResponse>(draft, requestId, { headers: NO_STORE });
  },
  { quiet: true },
);
