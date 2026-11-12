/**
 * T24: `POST /api/v1/public/galleries/{slug}/archives` against the local database — recipient
 * authorization, content binding and reuse, partitioning, outbox, admission and rate limits.
 * T25: `GET /api/v1/public/archives/{jobId}` — access re-checks, statuses, TTL and part URLs.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ARCHIVE_LIMITS, RATE_LIMITS, mediaTokenKeyringSchema } from '@lumra/config';
import {
  archivePartEntriesSchema,
  archiveStatusResponseSchema,
  createArchiveResponseSchema,
} from '@lumra/contracts';
import { verifyMediaToken } from '@lumra/tokens';
import { GET as getArchive } from '../src/app/api/v1/public/archives/[jobId]/route';
import { POST as postArchive } from '../src/app/api/v1/public/galleries/[slug]/archives/route';
import { POST as postUnlock } from '../src/app/api/v1/public/galleries/[slug]/unlock/route';
import { GALLERY_SESSION_COOKIE } from '../src/lib/gallery-session';
import { hashGalleryPassword } from '../src/lib/password';
import { cleanup, createUser, ctx, readJson, resetContext, slug as newSlug, sql } from './fixtures';
import { freshIp } from './helpers';

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

function req(
  path: string,
  init: { body?: unknown; ip?: string; headers?: Record<string, string> } = {},
) {
  return new Request(new URL(path, 'http://localhost:3000'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': init.ip ?? freshIp(),
      ...init.headers,
    },
    body: JSON.stringify(init.body ?? {}),
  });
}

const create = (slug: string, body: unknown = {}, ip?: string, headers?: Record<string, string>) =>
  postArchive(
    req(`/api/v1/public/galleries/${slug}/archives`, { body, ip, headers }),
    params(slug),
  );

interface GalleryFixture {
  id: string;
  slug: string;
  ownerId: string;
}

async function gallery(
  opts: {
    status?: 'draft' | 'published' | 'deleted';
    expiresAt?: Date | null;
    password?: string;
  } = {},
): Promise<GalleryFixture> {
  const ownerId = await createUser('pro');
  const slug = newSlug();
  const status = opts.status ?? 'published';
  const passwordHash = opts.password ? await hashGalleryPassword(opts.password) : null;
  const [row] = await sql<{ id: string }[]>`
    insert into public.galleries (owner_id, slug, title, status, published_at, expires_at,
                                  password_hash, deleted_at)
    values (${ownerId}, ${slug}, 'Autumn', ${status},
            ${status === 'draft' ? null : new Date()}, ${opts.expiresAt ?? null},
            ${passwordHash}, ${status === 'deleted' ? new Date() : null})
    returning id`;
  return { id: row!.id, slug, ownerId };
}

let seq = 0;
async function addMedia(
  g: GalleryFixture,
  status = 'ready',
  opts: { filename?: string; bytes?: number } = {},
): Promise<string> {
  const id = randomUUID();
  seq++;
  await sql`
    insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key,
                              status, width, height, ready_at, deleted_at)
    values (${id}, ${g.id}, ${`originals/${g.ownerId}/${g.id}/${id}/source`},
            ${opts.filename ?? `IMG_${seq}.jpg`}, 'image/jpeg', ${opts.bytes ?? 1000},
            ${`a${String(seq).padStart(6, '0')}`}, ${status},
            ${status === 'ready' ? 3000 : null}, ${status === 'ready' ? 2000 : null},
            ${status === 'ready' ? new Date() : null},
            ${status === 'deleting' ? new Date() : null})`;
  return id;
}

async function expectCreated(res: Response, status = 201) {
  const body = await readJson(res);
  expect(body.error).toBeNull();
  expect(res.status).toBe(status);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  return createArchiveResponseSchema.parse(body.data);
}

async function jobRow(jobId: string) {
  const [row] = await sql<
    {
      status: string;
      content_version: number;
      access_version: number;
      parts_expected: number;
      item_count: number;
      total_bytes: string;
      source_fingerprint: string;
    }[]
  >`select status, content_version, access_version, parts_expected, item_count,
           total_bytes::text, source_fingerprint
    from public.archive_jobs where id = ${jobId}`;
  return row;
}

beforeEach(resetContext);
afterAll(async () => {
  await sql`delete from public.job_outbox where event_name = 'archive.build'
            and aggregate_id in (select id from public.archive_jobs where gallery_id in (
              select id from public.galleries where title = 'Autumn'))`;
  await cleanup();
});

describe('POST /api/v1/public/galleries/{slug}/archives — authorization', () => {
  it('denies unknown, draft and deleted galleries with the same 404', async () => {
    const draft = await gallery({ status: 'draft' });
    const deleted = await gallery({ status: 'deleted' });
    await addMedia(draft);
    await addMedia(deleted);
    for (const slug of ['nope-not-a-gallery', draft.slug, deleted.slug, '../etc']) {
      const res = await create(slug);
      expect(res.status).toBe(404);
      expect((await readJson(res)).error?.code).toBe('not_found');
    }
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.archive_jobs where gallery_id in (${draft.id}, ${deleted.id})`;
    expect(row!.n).toBe(0);
  });

  it('denies expired galleries (410)', async () => {
    const g = await gallery({ expiresAt: new Date(Date.now() - 60_000) });
    await addMedia(g);
    const res = await create(g.slug);
    expect(res.status).toBe(410);
    expect((await readJson(res)).error?.code).toBe('gallery_expired');
  });

  it('requires a live gallery session for password-protected galleries', async () => {
    const g = await gallery({ password: 'correct horse' });
    const other = await gallery({ password: 'other' });
    await addMedia(g);

    const locked = await create(g.slug);
    expect(locked.status).toBe(401);
    expect((await readJson(locked)).error?.code).toBe('password_required');

    // Wrong password: no session, still locked.
    const bad = await postUnlock(
      req(`/api/v1/public/galleries/${g.slug}/unlock`, { body: { password: 'nope' } }),
      params(g.slug),
    );
    expect(bad.status).toBe(401);
    expect((await create(g.slug)).status).toBe(401);

    // A session for a different gallery does not unlock this one.
    const unlockOther = await postUnlock(
      req(`/api/v1/public/galleries/${other.slug}/unlock`, { body: { password: 'other' } }),
      params(other.slug),
    );
    const otherToken = /lumra_gallery=([^;]+)/.exec(unlockOther.headers.getSetCookie()[0]!)![1]!;
    ctx.cookies.set(GALLERY_SESSION_COOKIE, otherToken);
    expect((await create(g.slug)).status).toBe(401);

    const unlocked = await postUnlock(
      req(`/api/v1/public/galleries/${g.slug}/unlock`, { body: { password: 'correct horse' } }),
      params(g.slug),
    );
    const token = /lumra_gallery=([^;]+)/.exec(unlocked.headers.getSetCookie()[0]!)![1]!;
    ctx.cookies.set(GALLERY_SESSION_COOKIE, token);
    const res = await create(g.slug);
    const data = await expectCreated(res);
    // The session is copied onto the job's page + status API paths only.
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain(`Path=/archive/${data.jobId}`);
    expect(cookies[1]).toContain(`Path=/api/v1/public/archives/${data.jobId}`);
    for (const c of cookies) {
      expect(c).toContain(`${GALLERY_SESSION_COOKIE}=${token}`);
      expect(c).toContain('HttpOnly');
      expect(c).toContain('SameSite=Lax');
    }

    // A password change bumps access_version: the old session no longer authorizes.
    await sql`update public.galleries set access_version = access_version + 1 where id = ${g.id}`;
    expect((await create(g.slug)).status).toBe(401);
  });

  it('rejects cross-origin requests and malformed bodies', async () => {
    const g = await gallery();
    await addMedia(g);
    expect((await create(g.slug, {}, undefined, { origin: 'https://evil.example' })).status).toBe(
      403,
    );
    expect((await create(g.slug, { mediaIds: [] })).status).toBe(422);
    expect((await create(g.slug, { mediaIds: ['x'] })).status).toBe(422);
    const id = randomUUID();
    expect((await create(g.slug, { mediaIds: [id, id] })).status).toBe(422);
  });

  it('is rate limited per client IP', async () => {
    const g = await gallery();
    await addMedia(g);
    const ip = freshIp();
    const { limit } = RATE_LIMITS.publicArchiveCreate;
    for (let i = 0; i < limit; i++) expect((await create(g.slug, {}, ip)).status).toBeLessThan(300);
    const res = await create(g.slug, {}, ip);
    expect(res.status).toBe(429);
  });
});

describe('POST /api/v1/public/galleries/{slug}/archives — jobs', () => {
  it('queues a job bound to the content version, with parts, entries and an outbox row', async () => {
    const g = await gallery();
    await sql`update public.galleries set content_version = 7, access_version = 3 where id = ${g.id}`;
    const a = await addMedia(g, 'ready', { filename: '../../etc/passwd' });
    const b = await addMedia(g, 'ready', { filename: 'IMG_1.jpg' });
    const c = await addMedia(g, 'ready', { filename: 'img_1.JPG' });
    await addMedia(g, 'uploading');
    await addMedia(g, 'failed');
    await addMedia(g, 'deleting');

    const data = await expectCreated(await create(g.slug));
    expect(data).toMatchObject({
      reused: false,
      status: 'preparing',
      itemCount: 3,
      partsExpected: 1,
    });
    expect(await jobRow(data.jobId)).toMatchObject({
      status: 'queued',
      content_version: 7,
      access_version: 3,
      parts_expected: 1,
      item_count: 3,
      total_bytes: '3000',
    });
    const parts = await sql<{ part_no: number; object_key: string; entries: unknown }[]>`
      select part_no, object_key, entries from public.archive_parts where job_id = ${data.jobId}`;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.object_key).toBe(`archives/${g.id}/${data.jobId}/1.zip`);
    const entries = archivePartEntriesSchema.parse(parts[0]!.entries);
    expect(entries.map((e) => [e.mediaId, e.name])).toEqual([
      [a, 'passwd.jpg'],
      [b, 'IMG_1.jpg'],
      [c, 'img_1 (2).JPG'],
    ]);
    const outbox = await sql<{ event_name: string; dedupe_key: string; payload: unknown }[]>`
      select event_name, dedupe_key, payload from public.job_outbox where aggregate_id = ${data.jobId}`;
    expect(outbox).toEqual([
      {
        event_name: 'archive.build',
        dedupe_key: `archive.build:${data.jobId}`,
        payload: expect.objectContaining({ jobId: data.jobId }),
      },
    ]);
  });

  it('reuses the job for the same content and starts a new one when content changes', async () => {
    const g = await gallery();
    await addMedia(g);
    const first = await expectCreated(await create(g.slug));
    const again = await expectCreated(await create(g.slug), 200);
    expect(again).toMatchObject({ jobId: first.jobId, reused: true });

    // A photo finishing processing changes the content (fingerprint) without a version bump.
    await addMedia(g);
    const withNew = await expectCreated(await create(g.slug));
    expect(withNew.jobId).not.toBe(first.jobId);
    expect(withNew.itemCount).toBe(2);

    // Reorder/delete bumps content_version: a new job, never the stale one.
    await sql`update public.galleries set content_version = content_version + 1 where id = ${g.id}`;
    const bumped = await expectCreated(await create(g.slug));
    expect(bumped.jobId).not.toBe(withNew.jobId);
  });

  it('reuses ready archives only while enough retention is left; never failed ones', async () => {
    const g = await gallery();
    await addMedia(g);
    const first = await expectCreated(await create(g.slug));
    await sql`update public.archive_jobs set status = 'ready',
              expires_at = now() + interval '20 hours' where id = ${first.jobId}`;
    const ready = await expectCreated(await create(g.slug), 200);
    expect(ready).toMatchObject({ jobId: first.jobId, status: 'ready', reused: true });

    await sql`update public.archive_jobs set expires_at = now() + ${
      ARCHIVE_LIMITS.reuseMinRemainingMs / 2 / 1000
    } * interval '1 second' where id = ${first.jobId}`;
    const fresh = await expectCreated(await create(g.slug));
    expect(fresh.jobId).not.toBe(first.jobId);

    await sql`update public.archive_jobs set status = 'failed', failure_code = 'build_failed'
              where id = ${fresh.jobId}`;
    const retry = await expectCreated(await create(g.slug));
    expect(retry.jobId).not.toBe(fresh.jobId);
  });

  it('partitions into parts of ≤ 500 items and ≤ 2 GB', async () => {
    const g = await gallery();
    // 41 × 50 MB (the per-photo maximum): exactly 2 GB fit in part 1, the 41st starts part 2.
    for (let i = 0; i < 41; i++) await addMedia(g, 'ready', { bytes: 50_000_000 });
    const data = await expectCreated(await create(g.slug));
    expect(data.partsExpected).toBe(2);
    const parts = await sql<{ item_count: number; source_bytes: string }[]>`
      select item_count, source_bytes::text from public.archive_parts
      where job_id = ${data.jobId} order by part_no`;
    expect(parts).toEqual([
      { item_count: 40, source_bytes: '2000000000' },
      { item_count: 1, source_bytes: '50000000' },
    ]);
    expect((await jobRow(data.jobId))!.total_bytes).toBe('2050000000');
  });

  it('archives only the requested ready items when mediaIds is given', async () => {
    const g = await gallery();
    const a = await addMedia(g);
    await addMedia(g);
    const pending = await addMedia(g, 'uploading');
    const foreign = randomUUID();
    const data = await expectCreated(await create(g.slug, { mediaIds: [a, pending, foreign] }));
    expect(data.itemCount).toBe(1);
    const res = await create(g.slug, { mediaIds: [pending] });
    expect(res.status).toBe(409);
    expect((await readJson(res)).error?.code).toBe('conflict');
  });

  it('refuses when nothing is ready yet', async () => {
    const g = await gallery();
    await addMedia(g, 'processing');
    const res = await create(g.slug);
    expect(res.status).toBe(409);
  });

  it('caps concurrently building jobs per gallery', async () => {
    const g = await gallery();
    const ids = [];
    for (let i = 0; i < ARCHIVE_LIMITS.maxActiveJobsPerGallery + 1; i++)
      ids.push(await addMedia(g));
    for (let i = 0; i < ARCHIVE_LIMITS.maxActiveJobsPerGallery; i++) {
      await expectCreated(await create(g.slug, { mediaIds: [ids[i]!] }));
    }
    const res = await create(g.slug, { mediaIds: [ids.at(-1)!] });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it('stops new archives for a past-due owner without revealing billing state', async () => {
    const g = await gallery();
    await addMedia(g);
    await sql`update public.billing_accounts set status = 'past_due', past_due_since = now()
              where user_id = ${g.ownerId}`;
    const res = await create(g.slug);
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error?.code).toBe('quota_exceeded');
    expect(JSON.stringify(body)).not.toMatch(/past_due|billing/i);
  });
});

// ---------------------------------------------------------------------------------------------
// T25: GET /api/v1/public/archives/{jobId}
// ---------------------------------------------------------------------------------------------

const keyring = mediaTokenKeyringSchema.parse(process.env.MEDIA_TOKEN_SECRET);
const status = (jobId: string) =>
  getArchive(
    new Request(new URL(`/api/v1/public/archives/${jobId}`, 'http://localhost:3000'), {
      headers: { 'x-forwarded-for': freshIp() },
    }),
    { params: Promise.resolve({ jobId }) },
  );

async function readStatus(res: Response, code = 200) {
  const body = await readJson(res);
  expect(body.error).toBeNull();
  expect(res.status).toBe(code);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  return archiveStatusResponseSchema.parse(body.data);
}

/** A gallery with `n` ready photos and a job created through the real POST route. */
async function jobFor(opts: { items?: number } = {}) {
  const g = await gallery();
  for (let i = 0; i < (opts.items ?? 2); i++) await addMedia(g);
  const created = await expectCreated(await create(g.slug));
  return { g, jobId: created.jobId };
}

async function markReady(jobId: string, expiresAt = new Date(Date.now() + 20 * 3600_000)) {
  await sql`update public.archive_parts set byte_size = source_bytes + 200, completed_at = now()
            where job_id = ${jobId}`;
  await sql`update public.archive_jobs set status = 'ready', progress_pct = 100,
            expires_at = ${expiresAt} where id = ${jobId}`;
}

describe('GET /api/v1/public/archives/{jobId}', () => {
  it('reports progress without URLs while building', async () => {
    const { g, jobId } = await jobFor();
    await sql`update public.archive_jobs set status = 'running', progress_pct = 37 where id = ${jobId}`;
    const data = await readStatus(await status(jobId));
    expect(data).toMatchObject({
      jobId,
      status: 'processing',
      progressPct: 37,
      gallery: { slug: g.slug, title: 'Autumn' },
      itemCount: 2,
      totalBytes: 2000,
      partsExpected: 1,
      expiresAt: null,
      failureCode: null,
    });
    expect(data.parts).toEqual([
      expect.objectContaining({ partNo: 1, itemCount: 2, ready: false, filename: 'Autumn.zip' }),
    ]);
    expect(data.parts[0]!.downloadUrl).toBeUndefined();
    expect(data.urlsExpireAt).toBeUndefined();
  });

  it('mints short-lived archive gateway URLs for every part once ready', async () => {
    const { g, jobId } = await jobFor();
    await markReady(jobId);
    const data = await readStatus(await status(jobId));
    expect(data.status).toBe('ready');
    expect(data.progressPct).toBe(100);
    expect(data.expiresAt).not.toBeNull();
    expect(data.urlsExpireAt).toBeDefined();
    const [part] = data.parts;
    expect(part).toMatchObject({ ready: true, byteSize: 2200 });
    const url = part!.downloadUrl!;
    expect(url.startsWith('https://media.lumra.test/m/')).toBe(true);
    const verified = await verifyMediaToken(
      url.slice('https://media.lumra.test/m/'.length),
      keyring,
    );
    expect(verified.status).toBe('ok');
    if (verified.status !== 'ok' || verified.claims.action !== 'archive') throw new Error('claims');
    const [partRow] = await sql<{ id: string }[]>`
      select id from public.archive_parts where job_id = ${jobId}`;
    expect(verified.claims).toMatchObject({
      gallery_id: g.id,
      archive_job_id: jobId,
      archive_part_no: 1,
      archive_part_id: partRow!.id,
      filename: 'Autumn.zip',
    });
    expect(verified.claims.exp - verified.claims.iat).toBeLessThanOrEqual(300);
  });

  it('treats a ready archive past its 24 h TTL as expired, leaving the transition to the sweep', async () => {
    const { jobId } = await jobFor();
    await markReady(jobId, new Date(Date.now() - 1000));
    const data = await readStatus(await status(jobId));
    expect(data.status).toBe('expired');
    expect(data.parts.every((p) => p.downloadUrl === undefined)).toBe(true);
    const [row] = await sql<{ status: string }[]>`
      select status from public.archive_jobs where id = ${jobId}`;
    expect(row!.status).toBe('ready');
  });

  it('never offers an archive of content that has since changed (PRD §11)', async () => {
    const { g, jobId } = await jobFor();
    await markReady(jobId);
    await sql`update public.galleries set content_version = content_version + 1 where id = ${g.id}`;
    const data = await readStatus(await status(jobId));
    expect(data.status).toBe('expired');
    expect(data.parts[0]!.downloadUrl).toBeUndefined();
  });

  it('reports failures with their code', async () => {
    const { jobId } = await jobFor();
    await sql`update public.archive_jobs set status = 'failed', failure_code = 'content_changed'
              where id = ${jobId}`;
    expect(await readStatus(await status(jobId))).toMatchObject({
      status: 'failed',
      failureCode: 'content_changed',
    });
  });

  it('denies unknown, malformed, unpublished, deleted, revoked and expired', async () => {
    for (const id of [randomUUID(), 'not-a-uuid', '../../etc']) {
      expect((await status(id)).status).toBe(404);
    }
    const unpublished = await jobFor();
    await sql`update public.galleries set status = 'draft' where id = ${unpublished.g.id}`;
    expect((await status(unpublished.jobId)).status).toBe(404);

    const deleted = await jobFor();
    await sql`update public.galleries set status = 'deleted', deleted_at = now()
              where id = ${deleted.g.id}`;
    expect((await status(deleted.jobId)).status).toBe(404);

    const revoked = await jobFor();
    await sql`update public.galleries set access_version = access_version + 1
              where id = ${revoked.g.id}`;
    expect((await status(revoked.jobId)).status).toBe(404);

    const expired = await jobFor();
    await sql`update public.galleries set expires_at = now() - interval '1 minute'
              where id = ${expired.g.id}`;
    const res = await status(expired.jobId);
    expect(res.status).toBe(410);
    expect((await readJson(res)).error?.code).toBe('gallery_expired');
  });

  it('requires the gallery session (scoped to the job) for password-protected galleries', async () => {
    const g = await gallery({ password: 'pw-123' });
    await addMedia(g);
    const unlocked = await postUnlock(
      req(`/api/v1/public/galleries/${g.slug}/unlock`, { body: { password: 'pw-123' } }),
      params(g.slug),
    );
    const token = /lumra_gallery=([^;]+)/.exec(unlocked.headers.getSetCookie()[0]!)![1]!;
    ctx.cookies.set(GALLERY_SESSION_COOKIE, token);
    const { jobId } = await expectCreated(await create(g.slug));
    await markReady(jobId);

    expect((await readStatus(await status(jobId))).parts[0]!.downloadUrl).toBeDefined();

    ctx.cookies.clear();
    const locked = await status(jobId);
    expect(locked.status).toBe(401);
    const body = await readJson(locked);
    expect(body.error?.code).toBe('password_required');
    expect(JSON.stringify(body)).not.toContain('media.lumra.test');

    // A password change revokes the job for everyone, even with the old cookie.
    ctx.cookies.set(GALLERY_SESSION_COOKIE, token);
    await sql`update public.galleries set access_version = access_version + 1 where id = ${g.id}`;
    expect((await status(jobId)).status).toBe(404);
  });
});
