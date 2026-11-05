import type { ApiResponse, ClaimGuestDraftResponse } from '@lumra/contracts';

export type ClaimOutcome =
  | { ok: true; data: ClaimGuestDraftResponse }
  | { ok: false; code: string; message: string; retryable: boolean };

/** Browser helper for `POST /api/v1/guest/drafts/claim` (T07). Cookies carry auth + capability. */
export async function claimGuestDraftRequest(galleryId: string): Promise<ClaimOutcome> {
  try {
    const res = await fetch('/api/v1/guest/drafts/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ galleryId }),
      credentials: 'same-origin',
    });
    const body = (await res.json()) as ApiResponse<ClaimGuestDraftResponse>;
    if (body.error) return { ok: false, ...body.error };
    return { ok: true, data: body.data };
  } catch {
    return {
      ok: false,
      code: 'network',
      message: 'Network error. Check your connection and try again.',
      retryable: true,
    };
  }
}

export function authUrlForPublish(galleryId: string, returnTo: string): string {
  const query = new URLSearchParams({ returnTo, intent: 'publish', galleryId });
  return `/auth?${query}`;
}
