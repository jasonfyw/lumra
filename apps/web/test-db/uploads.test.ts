/**
 * T10: upload intent / sign / resume / complete / abort through the real route handlers, against
 * the local Supabase DB and an in-memory R2 fake at the fetch level (test-db/fake-r2.ts).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GALLERY_LIMITS, UPLOAD_LIMITS } from '@lumra/config';
import { outboxRowToQueueMessage } from '@lumra/contracts';
import { POST as createIntent } from '@/app/api/v1/galleries/[id]/upload-intents/route';
import { GET as getUpload } from '@/app/api/v1/uploads/[id]/route';
import { POST as signParts } from '@/app/api/v1/uploads/[id]/parts/sign/route';
import { POST as complete } from '@/app/api/v1/uploads/[id]/complete/route';
import { POST as abort } from '@/app/api/v1/uploads/[id]/abort/route';
import {
  actAs,
  cleanup,
  createOwnedGallery,
  createUser,
  guestUsage,
  jsonRequest,
  newDraft,
  params,
  readJson,
  sql,
  state,
} from './helpers';

const MIB = 1024 * 1024;
const r2 = state.r2;

beforeEach(() => r2.reset());
afterEach(cleanup);
afterAll(() => sql.end());

interface Intent {
  intentId: string;
  mediaId: string;
  multipart: boolean;
  partSize: number;
  partCount: number;
  expiresAt: string;
  status: string;
  mediaStatus: string;
}
interface Signed {
  parts: {
    partNumber: number;
    url: string;
    headers: Record<string, string>;
    contentLength: number;
    expiresAt: string;
  }[];
}

const file = (
  size: number,
  extra: Partial<{ filename: string; mime: string; clientId: string }> = {},
) => ({
  filename: 'IMG_0001.JPG',
  mime: 'image/jpeg',
  size,
  clientId: randomUUID(),
  ...extra,
});

async function intent(galleryId: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await createIntent(
    jsonRequest(`/api/v1/galleries/${galleryId}/upload-intents`, body, { headers }),
    params(galleryId),
  );
  return { res, body: await readJson<Intent>(res) };
}

async function sign(uploadId: string, partNumbers: number[]) {
  const res = await signParts(
    jsonRequest(`/api/v1/uploads/${uploadId}/parts/sign`, { partNumbers }),
    params(uploadId),
  );
  return { res, body: await readJson<Signed>(res) };
}

async function finish(uploadId: string, body: unknown = {}) {
  const res = await complete(
    jsonRequest(`/api/v1/uploads/${uploadId}/complete`, body),
    params(uploadId),
  );
  return { res, body: await readJson(res) };
}

async function cancel(uploadId: string) {
  const res = await abort(jsonRequest(`/api/v1/uploads/${uploadId}/abort`, {}), params(uploadId));
  return { res, body: await readJson(res) };
}

async function state_(uploadId: string) {
  const res = await getUpload(jsonRequest(`/api/v1/uploads/${uploadId}`), params(uploadId));
  return {
    res,
    body: await readJson<{
      parts: { number: number; etag: string; size: number }[];
      status: string;
      mediaStatus: string;
    }>(res),
  };
}

async function outboxRows(mediaId: string, eventName: string) {
  return sql<{ dedupe_key: string; payload: Record<string, unknown> }[]>`
    select dedupe_key, payload from public.job_outbox
    where aggregate_id = ${mediaId} and event_name = ${eventName}`;
}

async function guestDraft() {
  const draft = await newDraft();
  actAs({ guestCookie: draft.capability });
  return { ...draft, galleryId: draft.body.data.galleryId };
}

describe('guest quota (FR-A02, PRD §11)', () => {
  it('21 concurrent upload intents for a guest => exactly 20 succeed', async () => {
    const { galleryId, guestSessionId } = await guestDraft();
    const results = await Promise.all(
      Array.from({ length: 21 }, () => intent(galleryId, file(1_000_000))),
    );
    const statuses = results.map((r) => r.res.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(20);
    const refused = results.filter((r) => r.res.status !== 201);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.res.status).toBe(403);
    expect(refused[0]!.body.error).toMatchObject({
      code: 'quota_exceeded',
      details: { reason: 'guest_file_limit', requiresAuth: true },
    });
    expect(await guestUsage(guestSessionId)).toEqual({ files: 20, bytes: 20_000_000 });
    const [counted] = await sql<{ count: number }[]>`
      select count(*)::int as count from public.media where gallery_id = ${galleryId}`;
    expect(counted!.count).toBe(20);
    // Sort keys are distinct and appended in order.
    const keys = await sql<{ sort_key: string }[]>`
      select sort_key from public.media where gallery_id = ${galleryId} order by created_at`;
    expect(new Set(keys.map((k) => k.sort_key)).size).toBe(20);
  });

  it('enforces the 250,000,000 byte cap (multipart files)', async () => {
    const { galleryId, guestSessionId } = await guestDraft();
    for (let i = 0; i < 5; i++) {
      const { res, body } = await intent(galleryId, file(50_000_000));
      expect(res.status).toBe(201);
      expect(body.data).toMatchObject({ multipart: true, partSize: 8 * MIB, partCount: 6 });
    }
    expect(await guestUsage(guestSessionId)).toEqual({ files: 5, bytes: 250_000_000 });
    const { res, body } = await intent(galleryId, file(1));
    expect(res.status).toBe(403);
    expect(body.error?.details).toMatchObject({ reason: 'guest_byte_limit', requiresAuth: true });
    // A multipart upload was created in R2 for each accepted intent, keyed by the guest id.
    const creates = r2.calls.filter((c) => c.operation === 'CreateMultipartUpload');
    expect(creates).toHaveLength(5);
    for (const c of creates) {
      expect(c.key).toMatch(
        new RegExp(`^originals/${guestSessionId}/${galleryId}/[0-9a-f-]{36}/source$`),
      );
    }
  });

  it('an expired draft rejects intents; a missing cookie is unauthenticated', async () => {
    const { galleryId, guestSessionId, capability } = await guestDraft();
    await sql`update public.guest_sessions set expires_at = now() - interval '1 second'
              where id = ${guestSessionId}`;
    actAs({ guestCookie: capability });
    expect((await intent(galleryId, file(1000))).res.status).toBe(401);
    actAs({});
    expect((await intent(galleryId, file(1000))).res.status).toBe(401);
    expect(await guestUsage(guestSessionId)).toEqual({ files: 0, bytes: 0 });
  });

  it("a guest can't upload into another guest's draft or an account gallery (404)", async () => {
    const a = await guestDraft();
    const b = await guestDraft();
    const owner = await createUser();
    const owned = await createOwnedGallery(owner.id);
    actAs({ guestCookie: b.capability });
    expect((await intent(a.galleryId, file(1000))).res.status).toBe(404);
    expect((await intent(owned, file(1000))).res.status).toBe(404);
    expect((await intent(randomUUID(), file(1000))).res.status).toBe(404);
    expect((await intent('not-a-uuid', file(1000))).res.status).toBe(404);
  });
});

describe('upload intents', () => {
  it('is idempotent by clientId (same intent, reserved once)', async () => {
    const { galleryId, guestSessionId } = await guestDraft();
    const body = file(2_000_000);
    const first = await intent(galleryId, body, { 'idempotency-key': body.clientId });
    const second = await intent(galleryId, body);
    expect(first.res.status).toBe(201);
    expect(second.res.status).toBe(200);
    expect(second.body.data.intentId).toBe(first.body.data.intentId);
    expect(second.body.data.mediaId).toBe(first.body.data.mediaId);
    expect(await guestUsage(guestSessionId)).toEqual({ files: 1, bytes: 2_000_000 });

    // Same clientId for a different file is a conflict; a mismatched header is invalid.
    expect((await intent(galleryId, { ...body, size: 3_000_000 })).res.status).toBe(409);
    expect(
      (await intent(galleryId, file(10), { 'idempotency-key': randomUUID() })).res.status,
    ).toBe(422);
  });

  it('validates input: extension, mime, size; never stores the raw filename as a key', async () => {
    const { galleryId } = await guestDraft();
    expect((await intent(galleryId, file(10, { filename: 'evil.exe' }))).res.status).toBe(422);
    expect((await intent(galleryId, file(10, { mime: 'video/mp4' }))).res.status).toBe(422);
    expect((await intent(galleryId, file(UPLOAD_LIMITS.maxPhotoBytes + 1))).res.status).toBe(422);
    const { res, body } = await intent(galleryId, file(10, { filename: '../../etc/passwd.jpg' }));
    expect(res.status).toBe(201);
    const [row] = await sql<{ original_key: string; filename: string; status: string }[]>`
      select original_key, filename, status from public.media where id = ${body.data.mediaId}`;
    expect(row!.original_key).not.toContain('passwd');
    expect(row!.filename).not.toContain('/');
    expect(row!.status).toBe('reserved');
  });

  it(`caps a gallery at ${GALLERY_LIMITS.maxItemsPerGallery} items`, async () => {
    const owner = await createUser();
    const galleryId = await createOwnedGallery(owner.id);
    await sql`
      insert into public.media (gallery_id, original_key, filename, mime, byte_size, sort_key, status, ready_at)
      select ${galleryId}, 'originals/seed/' || ${galleryId} || '/' || gen_random_uuid() || '/source',
             'p.jpg', 'image/jpeg', 1, 'a' || lpad(i::text, 5, '0'), 'ready', now()
      from generate_series(1, ${GALLERY_LIMITS.maxItemsPerGallery}) i`;
    actAs({ user: owner });
    const { res, body } = await intent(galleryId, file(10));
    expect(res.status).toBe(403);
    expect(body.error?.details).toMatchObject({ reason: 'gallery_item_limit' });
  });

  it('admits account uploads against the Free 1 GB cap including the derivative estimate', async () => {
    const owner = await createUser();
    const galleryId = await createOwnedGallery(owner.id);
    // 15 × 50 MB committed → 750 MB + 25 % + 15 × 100 kB = 939 MB estimated footprint.
    await sql`
      insert into public.media (gallery_id, original_key, filename, mime, byte_size, sort_key, status, ready_at)
      select ${galleryId}, 'originals/' || ${owner.id} || '/' || ${galleryId} || '/' || gen_random_uuid() || '/source',
             'p.jpg', 'image/jpeg', 50000000, 'a' || lpad(i::text, 3, '0'), 'ready', now()
      from generate_series(1, 15) i`;
    actAs({ user: owner });
    // +40 MB → 989.1 MB: allowed. Another 40 MB (pending reservations count) → 1,039 MB: denied.
    const ok = await intent(galleryId, file(40_000_000));
    expect(ok.res.status).toBe(201);
    const [session] = await sql<{ guest_session_id: string | null; expires_at: Date }[]>`
      select guest_session_id, expires_at from public.upload_sessions where id = ${ok.body.data.intentId}`;
    expect(session!.guest_session_id).toBeNull();
    expect(session!.expires_at.getTime() - Date.now()).toBeGreaterThan(47 * 3600_000);
    const denied = await intent(galleryId, file(40_000_000));
    expect(denied.res.status).toBe(403);
    expect(denied.body.error).toMatchObject({
      code: 'quota_exceeded',
      details: { reason: 'free_storage_cap' },
    });
  });

  it('rejects cross-origin mutations', async () => {
    const { galleryId } = await guestDraft();
    const res = await createIntent(
      jsonRequest(`/api/v1/galleries/${galleryId}/upload-intents`, file(10), {
        headers: { origin: 'https://evil.example' },
      }),
      params(galleryId),
    );
    expect(res.status).toBe(403);
  });
});

describe('single PUT flow', () => {
  it('signs a narrowly scoped PUT, completes once, and writes exactly one outbox row', async () => {
    const { galleryId } = await guestDraft();
    const size = 3_000_000;
    const { body } = await intent(galleryId, file(size));
    const { intentId, mediaId } = body.data;
    expect(body.data).toMatchObject({ multipart: false, partCount: 1, partSize: size });

    // Completing before the object exists is a retryable conflict.
    expect((await finish(intentId)).res.status).toBe(409);

    const signed = await sign(intentId, [1]);
    expect(signed.res.status).toBe(200);
    const part = signed.body.data.parts[0]!;
    const url = new URL(part.url);
    expect(url.origin).toBe('https://r2.fake.test');
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(15 * 60);
    expect(url.searchParams.get('X-Amz-SignedHeaders')!.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type', 'host']),
    );
    expect(part.headers).toEqual({ 'content-type': 'image/jpeg' });
    expect(part.contentLength).toBe(size);
    expect(new Date(part.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const [media1] = await sql<
      { status: string }[]
    >`select status from public.media where id = ${mediaId}`;
    expect(media1!.status).toBe('uploading');

    // The URL is bound to the exact length and content type.
    expect(r2.browserPut(part, size + 1).status).toBe(403);
    expect(r2.browserPut({ ...part, headers: { 'content-type': 'image/png' } }, size).status).toBe(
      403,
    );
    expect(r2.browserPut(part, size, new Date(Date.now() + 16 * 60_000)).status).toBe(403);
    expect(r2.browserPut(part, size).status).toBe(200);

    const checksum = 'a'.repeat(64);
    const done = await finish(intentId, { checksum });
    expect(done.res.status).toBe(200);
    expect(done.body.data).toMatchObject({
      intentId,
      mediaId,
      status: 'completed',
      mediaStatus: 'uploaded',
    });

    const again = await finish(intentId, { checksum });
    expect(again.res.status).toBe(200);
    expect(again.body.data).toMatchObject({ status: 'completed', mediaStatus: 'uploaded' });

    const rows = await outboxRows(mediaId, 'media.uploaded');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupe_key).toBe(`media.uploaded:${mediaId}`);
    // The worker relay turns the row into exactly this queue message (T12 outbox contract).
    expect(
      outboxRowToQueueMessage({
        id: 'row',
        eventName: 'media.uploaded',
        payload: rows[0]!.payload,
        dedupeKey: rows[0]!.dedupe_key,
      }),
    ).toMatchObject({ type: 'media.uploaded', mediaId, dedupeKey: `media.uploaded:${mediaId}` });
    const [media2] = await sql<{ status: string; checksum_sha256: string }[]>`
      select status, checksum_sha256 from public.media where id = ${mediaId}`;
    expect(media2).toEqual({ status: 'uploaded', checksum_sha256: checksum });

    // Completed uploads can't be signed or aborted any more.
    expect((await sign(intentId, [1])).res.status).toBe(409);
    expect((await cancel(intentId)).res.status).toBe(409);
  });

  it('rejects a completion whose object size differs from the reservation', async () => {
    const { galleryId } = await guestDraft();
    const { body } = await intent(galleryId, file(1_000_000));
    const { intentId, mediaId } = body.data;
    await sign(intentId, [1]);
    const [row] = await sql<
      { original_key: string }[]
    >`select original_key from public.media where id = ${mediaId}`;
    r2.objects.set(row!.original_key, { size: 999_999, contentType: 'image/jpeg' });

    const res = await finish(intentId);
    expect(res.res.status).toBe(409);
    expect(res.body.error?.details).toMatchObject({
      reason: 'size_mismatch',
      expected: 1_000_000,
      actual: 999_999,
    });
    expect(await outboxRows(mediaId, 'media.uploaded')).toHaveLength(0);
    const [media] = await sql<
      { status: string }[]
    >`select status from public.media where id = ${mediaId}`;
    expect(media!.status).toBe('uploading');
  });

  it('rejects part numbers outside the plan', async () => {
    const { galleryId } = await guestDraft();
    const { body } = await intent(galleryId, file(1000));
    expect((await sign(body.data.intentId, [2])).res.status).toBe(422);
    expect((await sign(body.data.intentId, [])).res.status).toBe(422);
  });
});

describe('multipart flow + resume', () => {
  it('resumes from server-reported parts and completes with client ETags', async () => {
    const owner = await createUser();
    const galleryId = await createOwnedGallery(owner.id);
    actAs({ user: owner });
    const size = 20 * MIB + 123;
    const { body } = await intent(galleryId, file(size));
    const { intentId, mediaId } = body.data;
    expect(body.data).toMatchObject({ multipart: true, partSize: 8 * MIB, partCount: 3 });

    const signed = await sign(intentId, [1, 2, 3]);
    const parts = signed.body.data.parts;
    expect(parts.map((p) => p.contentLength)).toEqual([8 * MIB, 8 * MIB, 4 * MIB + 123]);
    for (const p of parts) {
      const url = new URL(p.url);
      expect(url.searchParams.get('partNumber')).toBe(String(p.partNumber));
      expect(url.searchParams.get('uploadId')).toMatch(/^up-/);
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
      expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(900);
    }
    // A part URL can't be replayed for another part's length.
    expect(r2.browserPut(parts[0]!, 4 * MIB).status).toBe(403);

    const etags: Record<number, string> = {};
    for (const p of parts.slice(0, 2))
      etags[p.partNumber] = r2.browserPut(p, p.contentLength).etag!;

    // "Network drop": the client lost its state; the server reports what R2 already holds.
    const resumed = await state_(intentId);
    expect(resumed.res.status).toBe(200);
    expect(resumed.body.data.parts.map((p) => p.number)).toEqual([1, 2]);
    expect(JSON.stringify(resumed.body)).not.toMatch(/X-Amz|uploadId|up-/);

    // Incomplete or wrong part lists are refused before anything is assembled.
    expect(
      (
        await finish(intentId, {
          parts: [
            { number: 1, etag: etags[1] },
            { number: 2, etag: etags[2] },
          ],
        })
      ).res.status,
    ).toBe(422);
    const resigned = await sign(intentId, [3]);
    etags[3] = r2.browserPut(resigned.body.data.parts[0]!, 4 * MIB + 123).etag!;
    const wrong = await finish(intentId, {
      parts: [1, 2, 3].map((n) => ({ number: n, etag: n === 2 ? '"deadbeef"' : etags[n]! })),
    });
    expect(wrong.res.status).toBe(409);
    expect(wrong.body.error?.details).toMatchObject({ reason: 'part_mismatch', partNumbers: [2] });

    const allParts = [1, 2, 3].map((n) => ({ number: n, etag: etags[n]! }));
    const done = await finish(intentId, { parts: allParts });
    expect(done.res.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'completed', mediaStatus: 'uploaded' });
    expect([...r2.objects.values()][0]!.size).toBe(size);
    // Replay after R2 forgot the upload id still succeeds idempotently.
    expect((await finish(intentId, { parts: allParts })).res.status).toBe(200);
    expect(await outboxRows(mediaId, 'media.uploaded')).toHaveLength(1);
  });
});

describe('abort', () => {
  it('releases the guest reservation, marks media deleting and is idempotent', async () => {
    const { galleryId, guestSessionId } = await guestDraft();
    const { body } = await intent(galleryId, file(20 * MIB));
    const { intentId, mediaId } = body.data;
    expect(await guestUsage(guestSessionId)).toEqual({ files: 1, bytes: 20 * MIB });

    const res = await cancel(intentId);
    expect(res.res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'aborted', mediaStatus: 'deleting' });
    expect(await guestUsage(guestSessionId)).toEqual({ files: 0, bytes: 0 });
    expect(r2.calls.filter((c) => c.operation === 'AbortMultipartUpload')).toHaveLength(1);
    expect(r2.uploads.size).toBe(0);
    expect(await outboxRows(mediaId, 'media.delete')).toHaveLength(1);

    const again = await cancel(intentId);
    expect(again.res.status).toBe(200);
    expect(await guestUsage(guestSessionId)).toEqual({ files: 0, bytes: 0 });
    expect(await outboxRows(mediaId, 'media.delete')).toHaveLength(1);

    // The released slot can be used again; the aborted clientId can't be resurrected.
    expect((await intent(galleryId, file(1000))).res.status).toBe(201);
    expect((await sign(intentId, [1])).res.status).toBe(409);
    expect((await finish(intentId)).res.status).toBe(409);
  });
});

describe('authorization (404 concealed)', () => {
  it("a user can't sign/complete/abort/read another user's or a guest's upload", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const aliceGallery = await createOwnedGallery(alice.id);
    actAs({ user: alice });
    const aliceUpload = (await intent(aliceGallery, file(1000))).body.data.intentId;

    const guest = await guestDraft();
    const guestUpload = (await intent(guest.galleryId, file(1000))).body.data.intentId;
    const otherGuest = await newDraft();

    for (const actor of [{ user: bob }, { guestCookie: otherGuest.capability }]) {
      for (const upload of [aliceUpload, guestUpload]) {
        actAs(actor);
        expect((await sign(upload, [1])).res.status).toBe(404);
        expect((await finish(upload)).res.status).toBe(404);
        expect((await cancel(upload)).res.status).toBe(404);
        expect((await state_(upload)).res.status).toBe(404);
      }
    }
    // A guest cookie never grants access to an account-owned upload, and vice versa.
    actAs({ guestCookie: guest.capability });
    expect((await sign(aliceUpload, [1])).res.status).toBe(404);
    actAs({ user: alice });
    expect((await sign(guestUpload, [1])).res.status).toBe(404);

    // No credentials at all → 401; garbage ids → 404.
    actAs({});
    expect((await sign(aliceUpload, [1])).res.status).toBe(401);
    actAs({ user: alice });
    expect((await sign('nope', [1])).res.status).toBe(404);

    // Owners still can.
    expect((await sign(aliceUpload, [1])).res.status).toBe(200);
    actAs({ guestCookie: guest.capability });
    expect((await state_(guestUpload)).res.status).toBe(200);
  });

  it('a signed-in user still holding the guest cookie can keep uploading to the draft (J1)', async () => {
    const guest = await guestDraft();
    const user = await createUser();
    actAs({ user, guestCookie: guest.capability });
    const { res } = await intent(guest.galleryId, file(1000));
    expect(res.status).toBe(201);
    expect(await guestUsage(guest.guestSessionId)).toEqual({ files: 1, bytes: 1000 });
  });

  it('expired guest sessions are rejected for existing uploads', async () => {
    const guest = await guestDraft();
    const upload = (await intent(guest.galleryId, file(1000))).body.data.intentId;
    await sql`update public.guest_sessions set expires_at = now() - interval '1 second'
              where id = ${guest.guestSessionId}`;
    actAs({ guestCookie: guest.capability });
    expect((await sign(upload, [1])).res.status).toBe(401);
    expect((await finish(upload)).res.status).toBe(401);
  });

  it('a deleted gallery hides its uploads', async () => {
    const owner = await createUser();
    const galleryId = await createOwnedGallery(owner.id);
    actAs({ user: owner });
    const upload = (await intent(galleryId, file(1000))).body.data.intentId;
    await sql`update public.galleries set status = 'deleted', deleted_at = now() where id = ${galleryId}`;
    expect((await sign(upload, [1])).res.status).toBe(404);
    expect((await intent(galleryId, file(1000))).res.status).toBe(404);
  });
});
