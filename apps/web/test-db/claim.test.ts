import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as claim } from '../src/app/api/v1/guest/drafts/claim/route';
import {
  cleanup,
  createGuestDraft,
  createOwnedGallery,
  createUser,
  jsonRequest,
  readJson,
  resetContext,
  signInAs,
  sql,
  useGuestCookie,
} from './fixtures';

const CLAIM_URL = '/api/v1/guest/drafts/claim';
const post = (galleryId: unknown, headers?: Record<string, string>) =>
  claim(jsonRequest(CLAIM_URL, { body: { galleryId }, headers }), {});

async function galleryRow(id: string) {
  const [row] = await sql<
    { owner_id: string | null; guest_session_id: string | null; claimed_at: Date | null }[]
  >`select owner_id, guest_session_id, claimed_at from public.galleries where id = ${id}`;
  return row!;
}

beforeEach(resetContext);
afterAll(cleanup);

describe('POST /api/v1/guest/drafts/claim — authorization', () => {
  it('401 without a verified user, even with the guest cookie', async () => {
    const draft = await createGuestDraft();
    useGuestCookie(draft);
    const res = await post(draft.galleryId);
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe('unauthenticated');
    expect((await galleryRow(draft.galleryId)).owner_id).toBeNull();
  });

  it('404 for a signed-in user WITHOUT the guest cookie (no transfer by draft id alone)', async () => {
    const draft = await createGuestDraft();
    signInAs(await createUser());
    const res = await post(draft.galleryId);
    expect(res.status).toBe(404);
    expect((await readJson(res)).error?.code).toBe('not_found');
    const row = await galleryRow(draft.galleryId);
    expect(row.owner_id).toBeNull();
    expect(row.claimed_at).toBeNull();
  });

  it('404 with a valid guest cookie for a DIFFERENT guest session', async () => {
    const victim = await createGuestDraft();
    const attacker = await createGuestDraft();
    signInAs(await createUser());
    useGuestCookie(attacker);
    expect((await post(victim.galleryId)).status).toBe(404);
    expect((await galleryRow(victim.galleryId)).owner_id).toBeNull();
  });

  it('404 for an expired guest session, a deleted draft and an owned gallery', async () => {
    const user = await createUser();
    signInAs(user);

    const expired = await createGuestDraft({ expired: true });
    useGuestCookie(expired);
    expect((await post(expired.galleryId)).status).toBe(404);

    const deleted = await createGuestDraft();
    await sql`update public.galleries set status = 'deleted', deleted_at = now() where id = ${deleted.galleryId}`;
    useGuestCookie(deleted);
    expect((await post(deleted.galleryId)).status).toBe(404);

    const other = await createUser();
    const owned = await createOwnedGallery(other);
    const live = await createGuestDraft();
    useGuestCookie(live);
    expect((await post(owned)).status).toBe(404);
    expect((await galleryRow(owned)).owner_id).toBe(other);
  });

  it('403 for a cross-origin request and 422 for an invalid body', async () => {
    const draft = await createGuestDraft();
    signInAs(await createUser());
    useGuestCookie(draft);
    expect((await post(draft.galleryId, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('not-a-uuid')).status).toBe(422);
    expect((await galleryRow(draft.galleryId)).owner_id).toBeNull();
  });
});

describe('POST /api/v1/guest/drafts/claim — transfer', () => {
  it('transfers the draft atomically, keeps in-flight uploads and clears the guest cookie', async () => {
    const draft = await createGuestDraft();
    const user = await createUser();
    signInAs(user);
    useGuestCookie(draft);

    const res = await post(draft.galleryId, { origin: 'http://localhost:3000' });
    expect(res.status).toBe(200);
    const body = await readJson<{
      galleryId: string;
      alreadyClaimed: boolean;
      pendingUploads: number;
    }>(res);
    expect(body.data).toMatchObject({
      galleryId: draft.galleryId,
      alreadyClaimed: false,
      pendingUploads: 1,
    });
    expect(res.headers.get('set-cookie')).toMatch(/lumra_guest=;.*Max-Age=0/i);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const row = await galleryRow(draft.galleryId);
    expect(row.owner_id).toBe(user);
    expect(row.claimed_at).not.toBeNull();
    expect(row.guest_session_id).toBe(draft.guestSessionId); // provenance (ownership CHECK)

    const [session] = await sql<{ claimed_by_user_id: string; claimed_at: Date }[]>`
      select claimed_by_user_id, claimed_at from public.guest_sessions where id = ${draft.guestSessionId}`;
    expect(session!.claimed_by_user_id).toBe(user);
    expect(session!.claimed_at).not.toBeNull();

    // In-flight upload untouched: same session, still pending, same media + key.
    const [upload] = await sql<{ status: string; gallery_id: string }[]>`
      select status, gallery_id from public.upload_sessions where id = ${draft.uploadSessionId}`;
    expect(upload).toEqual({ status: 'pending', gallery_id: draft.galleryId });
    const [media] = await sql<{ status: string; upload_session_id: string }[]>`
      select status, upload_session_id from public.media where id = ${draft.mediaId}`;
    expect(media).toEqual({ status: 'uploading', upload_session_id: draft.uploadSessionId });

    // The upload can still be finalized after the claim (what T10's complete will do).
    await sql`update public.upload_sessions set status = 'completed', completed_at = now() where id = ${draft.uploadSessionId}`;
    await sql`update public.media set status = 'uploaded' where id = ${draft.mediaId}`;

    // The claimed draft now shows up in the owner's dashboard list.
    const { GET } = await import('../src/app/api/v1/galleries/route');
    const list = await readJson<{ items: { id: string; itemCount: number }[] }>(
      await GET(jsonRequest('/api/v1/galleries', { method: 'GET' }), {}),
    );
    expect(list.data!.items.map((g) => g.id)).toContain(draft.galleryId);
  });

  it('is idempotent for the same user (with or without the spent cookie)', async () => {
    const draft = await createGuestDraft();
    const user = await createUser();
    signInAs(user);
    useGuestCookie(draft);
    expect((await post(draft.galleryId)).status).toBe(200);

    const again = await post(draft.galleryId);
    expect(again.status).toBe(200);
    expect((await readJson<{ alreadyClaimed: boolean }>(again)).data!.alreadyClaimed).toBe(true);

    useGuestCookie(null);
    const withoutCookie = await post(draft.galleryId);
    expect(withoutCookie.status).toBe(200);
    expect(withoutCookie.headers.get('set-cookie')).toBeNull();

    // A different user replaying the spent cookie gets nothing.
    signInAs(await createUser());
    useGuestCookie(draft);
    expect((await post(draft.galleryId)).status).toBe(404);
    expect((await galleryRow(draft.galleryId)).owner_id).toBe(user);
  });

  it('re-checks the Free gallery cap inside the claim transaction', async () => {
    const user = await createUser('free');
    await createOwnedGallery(user);
    await createOwnedGallery(user);
    const draft = await createGuestDraft();
    signInAs(user);
    useGuestCookie(draft);

    const res = await post(draft.galleryId);
    expect(res.status).toBe(403);
    expect((await readJson(res)).error?.code).toBe('quota_exceeded');
    expect((await galleryRow(draft.galleryId)).owner_id).toBeNull();
    const [session] = await sql<{ claimed_at: Date | null }[]>`
      select claimed_at from public.guest_sessions where id = ${draft.guestSessionId}`;
    expect(session!.claimed_at).toBeNull();

    // Deleted galleries don't count: free a slot and the same claim succeeds.
    await sql`update public.galleries set status = 'deleted', deleted_at = now()
              where owner_id = ${user} and guest_session_id is null`;
    expect((await post(draft.galleryId)).status).toBe(200);
  });

  it('concurrent claims of one draft by two users: exactly one wins', async () => {
    const draft = await createGuestDraft();
    const [a, b] = [await createUser(), await createUser()];
    useGuestCookie(draft);
    // Both requests already passed authentication; run the transactions concurrently.
    const { claimGuestDraft } = await import('../src/lib/galleries');
    const results = await Promise.all(
      [a, b].map((userId) =>
        claimGuestDraft({
          userId,
          galleryId: draft.galleryId,
          guestSessionId: draft.guestSessionId,
        }),
      ),
    );
    expect(results.map((r) => r.kind).sort()).toEqual(['claimed', 'not_found']);
    expect([a, b]).toContain((await galleryRow(draft.galleryId)).owner_id);
  });
});
