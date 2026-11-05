import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mediaTokenKeyringSchema, RATE_LIMITS } from '@lumra/config';
import {
  mediaTokensResponseSchema,
  publicGalleryLookupSchema,
  publicGalleryResponseSchema,
  type MediaTokensResponse,
  type PublicGalleryLookup,
  type PublicGalleryResponse,
} from '@lumra/contracts';
import { verifyMediaToken } from '@lumra/tokens';
import { GET as getGallery } from '../src/app/api/v1/public/galleries/[slug]/route';
import { POST as postTokens } from '../src/app/api/v1/public/galleries/[slug]/media-tokens/route';
import { POST as postUnlock } from '../src/app/api/v1/public/galleries/[slug]/unlock/route';
import { GALLERY_SESSION_COOKIE } from '../src/lib/gallery-session';
import { hashGalleryPassword } from '../src/lib/password';
import { cleanup, createUser, ctx, readJson, resetContext, slug as newSlug, sql } from './fixtures';
import { freshIp } from './helpers';

const keyring = mediaTokenKeyringSchema.parse(process.env.MEDIA_TOKEN_SECRET);
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

function req(path: string, init: { method?: string; body?: unknown; ip?: string } = {}) {
  return new Request(new URL(path, 'http://localhost:3000'), {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': init.ip ?? freshIp() },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const get = (slug: string, query = '', ip?: string) =>
  getGallery(req(`/api/v1/public/galleries/${slug}${query}`, { ip }), params(slug));
const unlock = (slug: string, password: string, ip?: string) =>
  postUnlock(
    req(`/api/v1/public/galleries/${slug}/unlock`, { body: { password }, ip }),
    params(slug),
  );
const tokens = (slug: string, mediaIds: string[], action: 'preview' | 'original' = 'preview') =>
  postTokens(
    req(`/api/v1/public/galleries/${slug}/media-tokens`, { body: { mediaIds, action } }),
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
    plan?: 'free' | 'pro';
  } = {},
): Promise<GalleryFixture> {
  const ownerId = await createUser(opts.plan ?? 'free');
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
  status: string,
  opts: { variants?: boolean; filename?: string } = {},
): Promise<string> {
  const id = randomUUID();
  seq++;
  await sql`
    insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key,
                              status, width, height, ready_at, created_at, deleted_at)
    values (${id}, ${g.id}, ${`originals/${g.ownerId}/${g.id}/${id}/source`},
            ${opts.filename ?? `IMG_${seq}.jpg`}, 'image/jpeg', 1000,
            ${`a${String(seq).padStart(6, '0')}`}, ${status},
            ${status === 'ready' ? 3000 : null}, ${status === 'ready' ? 2000 : null},
            ${status === 'ready' ? new Date() : null}, ${new Date(Date.now() + seq)},
            ${status === 'deleting' || status === 'deleted' ? new Date() : null})`;
  if (status === 'ready' && opts.variants !== false) {
    for (const w of [320, 640]) {
      await sql`
        insert into public.media_variants (media_id, variant, object_key, mime, width, height, byte_size)
        values (${id}, ${`w${w}`}, ${`derivatives/${g.id}/${id}/w${w}abc1234.webp`}, 'image/webp',
                ${w}, ${Math.round((w * 2) / 3)}, 100)`;
    }
  }
  return id;
}

function tokenOf(url: string): string {
  expect(url.startsWith('https://media.lumra.test/m/')).toBe(true);
  return url.slice('https://media.lumra.test/m/'.length);
}

/** Copies the session cookie from an unlock response into the fake cookie jar. */
function adoptSessionCookie(res: Response) {
  const cookies = res.headers.getSetCookie();
  expect(cookies).toHaveLength(2);
  const value = /lumra_gallery=([^;]+)/.exec(cookies[0]!)?.[1];
  ctx.cookies.set(GALLERY_SESSION_COOKIE, value!);
  return cookies;
}

beforeEach(resetContext);
afterAll(cleanup);

describe('GET /api/v1/public/galleries/{slug}', () => {
  it('404s unknown, draft and deleted galleries identically', async () => {
    const draft = await gallery({ status: 'draft' });
    const deleted = await gallery({ status: 'deleted' });
    for (const slug of ['nope-not-a-gallery', draft.slug, deleted.slug, '../etc']) {
      const res = await get(slug);
      expect(res.status).toBe(404);
      expect((await readJson(res)).error?.code).toBe('not_found');
    }
  });

  it('expired galleries get a distinct 410 gallery_expired', async () => {
    const g = await gallery({ expiresAt: new Date(Date.now() - 60_000) });
    const res = await get(g.slug);
    expect(res.status).toBe(410);
    expect((await readJson(res)).error?.code).toBe('gallery_expired');
  });

  it('returns items in sort order with placeholders, previews and branding', async () => {
    const g = await gallery({ plan: 'pro' });
    const a = await addMedia(g, 'ready', { filename: 'first.jpg' });
    const b = await addMedia(g, 'uploading');
    const c = await addMedia(g, 'failed');
    const d = await addMedia(g, 'ready', { variants: false }); // ready but undisplayable
    await addMedia(g, 'deleting');

    const res = await get(g.slug);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await readJson<PublicGalleryResponse>(res);
    const data = publicGalleryResponseSchema.parse(body.data);
    expect(data.gallery).toMatchObject({ id: g.id, title: 'Autumn', brandingVisible: false });
    expect(data.items.map((i) => [i.id, i.status])).toEqual([
      [a, 'ready'],
      [b, 'pending'],
      [c, 'unavailable'],
      [d, 'unavailable'],
    ]);
    const ready = data.items[0]!;
    expect(ready.variants.map((v) => v.width)).toEqual([320, 640]);
    expect(ready.downloadUrl).toBeUndefined(); // originals are minted on demand only
    expect(data.urlsExpireAt).toBeDefined();
    // Recipients never see internal states, keys or errors.
    const json = JSON.stringify(body);
    for (const leak of ['uploading', 'failed', 'originals/', 'derivatives/', 'failure']) {
      expect(json).not.toContain(leak);
    }

    const verified = await verifyMediaToken(tokenOf(ready.variants[1]!.url), keyring);
    expect(verified.status).toBe('ok');
    if (verified.status !== 'ok') return;
    expect(verified.kid).toBe('k2'); // first keyring entry signs
    expect(verified.claims).toMatchObject({
      action: 'preview',
      gallery_id: g.id,
      media_id: a,
      variant: 'w640',
      variant_hash: 'w640abc1234',
      access_version: 1,
    });
    expect(verified.claims.exp - verified.claims.iat).toBeLessThanOrEqual(300);
  });

  it('?urls=0 (polling) returns statuses without minting', async () => {
    const g = await gallery();
    await addMedia(g, 'ready');
    const data = publicGalleryResponseSchema.parse(
      (await readJson(await get(g.slug, '?urls=0'))).data,
    );
    expect(data.items[0]!.status).toBe('ready');
    expect(data.items[0]!.variants).toEqual([]);
    expect(data.urlsExpireAt).toBeUndefined();
  });

  it('mints only a bounded initial window for large galleries', async () => {
    const g = await gallery();
    await sql`
      insert into public.media (gallery_id, original_key, filename, mime, byte_size, sort_key, status, width, height, ready_at)
      select ${g.id}::uuid, 'originals/x/' || ${g.id} || '/' || n || '/source', 'p.jpg', 'image/jpeg',
             1000, 'b' || lpad(n::text, 5, '0'), 'ready', 300, 200, now()
      from generate_series(1, 120) n`;
    await sql`
      insert into public.media_variants (media_id, variant, object_key, mime, width, height, byte_size)
      select id, 'w320', 'derivatives/' || gallery_id || '/' || id || '/w320abc1234.webp',
             'image/webp', 300, 200, 10
      from public.media where gallery_id = ${g.id}`;
    const data = publicGalleryResponseSchema.parse((await readJson(await get(g.slug))).data);
    expect(data.items).toHaveLength(120);
    // The first 48 in display order, plus the hero when it falls outside that window.
    const minted = data.items.filter((i) => i.variants.length > 0).length;
    expect(minted).toBeGreaterThanOrEqual(48);
    expect(minted).toBeLessThanOrEqual(49);
    expect(data.items.slice(0, 48).every((i) => i.variants.length === 1)).toBe(true);
  });

  it('is rate limited per IP', async () => {
    const g = await gallery();
    const ip = freshIp();
    let last: Response | undefined;
    for (let i = 0; i <= RATE_LIMITS.publicGalleryRead.limit; i++)
      last = await get(g.slug, '?urls=0', ip);
    expect(last!.status).toBe(429);
  });
});

describe('password gate (T19)', () => {
  it('reveals nothing until unlocked, then the full payload', async () => {
    const g = await gallery({ password: 'correct horse' });
    const m = await addMedia(g, 'ready');

    const locked = await readJson<PublicGalleryLookup>(await get(g.slug));
    expect(locked.data).toEqual({ passwordRequired: true });
    expect(JSON.stringify(locked)).not.toContain('Autumn');
    expect(publicGalleryLookupSchema.safeParse(locked.data).success).toBe(true);

    const tokRes = await tokens(g.slug, [m]);
    expect(tokRes.status).toBe(401);
    expect((await readJson(tokRes)).error?.code).toBe('password_required');

    const res = await unlock(g.slug, 'correct horse');
    expect(res.status).toBe(200);
    const cookies = adoptSessionCookie(res);
    expect(cookies[0]).toContain(`Path=/g/${g.slug}`);
    expect(cookies[1]).toContain(`Path=/api/v1/public/galleries/${g.slug}`);
    for (const c of cookies) {
      expect(c).toContain('HttpOnly');
      expect(c).toContain('SameSite=Lax');
    }
    const [session] = await sql<{ token_hash: string; access_version: number }[]>`
      select token_hash, access_version from public.gallery_access_sessions where gallery_id = ${g.id}`;
    expect(session!.access_version).toBe(1);
    expect(session!.token_hash).not.toBe(ctx.cookies.get(GALLERY_SESSION_COOKIE)); // hash only

    const open = publicGalleryResponseSchema.parse((await readJson(await get(g.slug))).data);
    expect(open.items.map((i) => i.id)).toEqual([m]);
    expect((await tokens(g.slug, [m])).status).toBe(200);
  });

  it('a session for one gallery does not unlock another', async () => {
    const a = await gallery({ password: 'pw-a' });
    const b = await gallery({ password: 'pw-b' });
    adoptSessionCookie(await unlock(a.slug, 'pw-a'));
    expect((await readJson(await get(b.slug))).data).toEqual({ passwordRequired: true });
  });

  it('wrong passwords 401 and are throttled per IP', async () => {
    const g = await gallery({ password: 'right' });
    const ip = freshIp();
    const first = await unlock(g.slug, 'wrong', ip);
    expect(first.status).toBe(401);
    expect((await readJson(first)).error?.code).toBe('invalid_password');
    expect(first.headers.get('set-cookie')).toBeNull();
    let last: Response | undefined;
    for (let i = 1; i <= RATE_LIMITS.galleryUnlock.limit; i++)
      last = await unlock(g.slug, 'wrong', ip);
    expect(last!.status).toBe(429);
    // Even the right password is refused while throttled.
    expect((await unlock(g.slug, 'right', ip)).status).toBe(429);
    expect((await unlock(g.slug, '', freshIp())).status).toBe(422);
  });

  it('sessions die when access_version changes (password change)', async () => {
    const g = await gallery({ password: 'old' });
    const m = await addMedia(g, 'ready');
    adoptSessionCookie(await unlock(g.slug, 'old'));
    expect((await tokens(g.slug, [m])).status).toBe(200);

    await sql`update public.galleries set access_version = access_version + 1,
              password_hash = ${await hashGalleryPassword('new')} where id = ${g.id}`;
    expect((await readJson(await get(g.slug))).data).toEqual({ passwordRequired: true });
    expect((await tokens(g.slug, [m])).status).toBe(401);
    expect((await unlock(g.slug, 'old')).status).toBe(401);
  });

  it('unlocking an expired or unknown gallery is not possible', async () => {
    const g = await gallery({ password: 'pw', expiresAt: new Date(Date.now() - 1000) });
    expect((await unlock(g.slug, 'pw')).status).toBe(410);
    expect((await unlock('unknown-slug-x', 'pw')).status).toBe(404);
  });

  it('refuses cross-origin unlock attempts', async () => {
    const g = await gallery({ password: 'pw' });
    const res = await postUnlock(
      new Request(`http://localhost:3000/api/v1/public/galleries/${g.slug}/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ password: 'pw' }),
      }),
      params(g.slug),
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/public/galleries/{slug}/media-tokens (T20)', () => {
  it('mints previews only for ready media of this gallery', async () => {
    const g = await gallery();
    const other = await gallery();
    const ready = await addMedia(g, 'ready');
    const pending = await addMedia(g, 'processing');
    const foreign = await addMedia(other, 'ready');
    const unknown = randomUUID();

    const res = await tokens(g.slug, [ready, pending, foreign, unknown]);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const data = mediaTokensResponseSchema.parse((await readJson<MediaTokensResponse>(res)).data);
    expect(data.items.map((i) => i.id)).toEqual([ready]);
    expect(data.missing).toEqual([pending, foreign, unknown]);
    for (const v of data.items[0]!.variants) {
      const r = await verifyMediaToken(tokenOf(v.url), keyring);
      expect(r.status === 'ok' && r.claims.gallery_id).toBe(g.id);
    }
  });

  it('mints originals with owner_ref from the storage key and a sanitized filename', async () => {
    const g = await gallery();
    const m = await addMedia(g, 'ready', { filename: '../../evil\u0007name.jpg' });
    await sql`update public.galleries set access_version = 7 where id = ${g.id}`;
    const data = mediaTokensResponseSchema.parse(
      (await readJson(await tokens(g.slug, [m], 'original'))).data,
    );
    const r = await verifyMediaToken(tokenOf(data.items[0]!.downloadUrl!), keyring);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok' || r.claims.action !== 'original') throw new Error('bad claims');
    expect(r.claims).toMatchObject({
      gallery_id: g.id,
      media_id: m,
      variant: 'original',
      owner_ref: g.ownerId,
      access_version: 7,
    });
    expect(r.claims.filename).toBeDefined();
    expect(r.claims.filename).not.toContain('/');
    expect(r.claims.filename).not.toContain('\u0007');
  });

  it('refuses expired, unknown and draft galleries, and bad bodies', async () => {
    const expired = await gallery({ expiresAt: new Date(Date.now() - 1000) });
    const draft = await gallery({ status: 'draft' });
    const m = await addMedia(expired, 'ready');
    expect((await tokens(expired.slug, [m])).status).toBe(410);
    expect((await tokens(draft.slug, [m])).status).toBe(404);
    const g = await gallery();
    expect((await tokens(g.slug, [])).status).toBe(422);
    const tooMany = Array.from({ length: 101 }, () => randomUUID());
    expect((await tokens(g.slug, tooMany)).status).toBe(422);
    expect(
      (
        await postTokens(
          req(`/api/v1/public/galleries/${g.slug}/media-tokens`, {
            body: { mediaIds: [m], action: 'archive' },
          }),
          params(g.slug),
        )
      ).status,
    ).toBe(422);
  });
});
