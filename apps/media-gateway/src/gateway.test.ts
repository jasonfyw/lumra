/**
 * Media gateway behaviour, including the in-scope PRD §11 security-matrix rows:
 * guessed key, expired/forged token, password change (access_version bump), deletion
 * mid-session, expired gallery, and fail-closed access state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mediaTokenKeyringSchema } from '@lumra/config';
import type { GalleryAccessState } from '@lumra/contracts';
import { archivePartKey, derivativeKey, originalKey } from '@lumra/media';
import { signMediaToken, type MediaTokenInput } from '@lumra/tokens';
import worker, { sentryOptions, type Env } from './index';
import { FakeExecutionContext, FakeKv, FakeR2Bucket } from './test-fakes';

const SECRET = 's'.repeat(48);
const KEYRING = mediaTokenKeyringSchema.parse(`k1:${SECRET}`);
const APP = 'https://lumra.vercel.app';
const GALLERY = '0b6f3c1e-8d0a-4a51-9a39-1f4f2a9d7e10';
const MEDIA = '5c7d1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const OWNER = 'owner-1234abcd';
const JOB = '1a2b3c4d-5e6f-4a7b-9c8d-0e1f2a3b4c5d';
const PART = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

const PREVIEW_BYTES = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
const ORIGINAL_BYTES = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 251));
const ARCHIVE_BYTES = new Uint8Array(Array.from({ length: 64 }, (_, i) => 255 - i));

const previewClaims: MediaTokenInput = {
  action: 'preview',
  gallery_id: GALLERY,
  media_id: MEDIA,
  variant: 'w640',
  variant_hash: 'w640v1',
  access_version: 1,
};
const originalClaims: MediaTokenInput = {
  action: 'original',
  gallery_id: GALLERY,
  media_id: MEDIA,
  variant: 'original',
  owner_ref: OWNER,
  filename: 'Wedding Day 001.JPG',
  access_version: 1,
};
const archiveClaims: MediaTokenInput = {
  action: 'archive',
  gallery_id: GALLERY,
  archive_part_id: PART,
  archive_job_id: JOB,
  archive_part_no: 1,
  access_version: 1,
};

const baseState: GalleryAccessState = {
  accessVersion: 1,
  deleted: false,
  expiresAt: null,
  deliverySuspended: false,
  updatedAt: '2026-11-05T00:00:00.000Z',
};

interface Harness {
  env: Env;
  kv: FakeKv;
  originals: FakeR2Bucket;
  derivatives: FakeR2Bucket;
  archives: FakeR2Bucket;
  logs: string[];
}

let h: Harness;

function setState(state: GalleryAccessState | null) {
  if (state === null) h.kv.data.delete(`gallery:${GALLERY}`);
  else h.kv.data.set(`gallery:${GALLERY}`, JSON.stringify(state));
}

beforeEach(() => {
  const kv = new FakeKv();
  const originals = new FakeR2Bucket();
  const derivatives = new FakeR2Bucket();
  const archives = new FakeR2Bucket();
  derivatives.put(derivativeKey(GALLERY, MEDIA, 'w640v1'), PREVIEW_BYTES, 'image/webp');
  originals.put(originalKey(OWNER, GALLERY, MEDIA), ORIGINAL_BYTES, 'image/jpeg');
  archives.put(archivePartKey(GALLERY, JOB, 1), ARCHIVE_BYTES, 'application/zip');
  const logs: string[] = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((line: string) => void logs.push(line));
  }
  const env = {
    APP_ORIGIN: `${APP},http://localhost:3000`,
    MEDIA_TOKEN_SECRET: `k1:${SECRET}`,
    ORIGINALS: originals,
    DERIVATIVES: derivatives,
    ARCHIVES: archives,
    ACCESS_STATE: kv,
  } as unknown as Env;
  h = { env, kv, originals, derivatives, archives, logs };
  setState(baseState);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function call(path: string, init: RequestInit = {}) {
  const ctx = new FakeExecutionContext();
  const res = await worker.fetch(
    new Request(`https://lumra-media-gateway.example.workers.dev${path}`, init),
    h.env,
    ctx as unknown as ExecutionContext,
  );
  await ctx.drain();
  return res;
}

const token = (claims: MediaTokenInput = previewClaims, now?: Date) =>
  signMediaToken(claims, KEYRING, now ? { now } : {});

const r2Untouched = () =>
  expect([...h.originals.calls, ...h.derivatives.calls, ...h.archives.calls]).toEqual([]);

async function expectGenericFailure(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(['Unauthorized', 'Forbidden', 'Not Found', 'Service Unavailable']).toContain(
    await res.text(),
  );
}

describe('routing', () => {
  it('reports health', async () => {
    expect((await call('/health')).status).toBe(200);
  });

  it('404s outside /m/ and rejects mutating methods', async () => {
    expect((await call('/originals/x')).status).toBe(404);
    const put = await call(`/m/${await token()}`, { method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
  });

  it('fails closed (503) when misconfigured', async () => {
    h.env = { ...h.env, MEDIA_TOKEN_SECRET: '' } as Env;
    const res = await call(`/m/${await token()}`);
    await expectGenericFailure(res, 503);
    r2Untouched();
  });

  it('answers CORS preflight only for app origins', async () => {
    const ok = await call(`/m/${await token()}`, {
      method: 'OPTIONS',
      headers: { Origin: APP, 'Access-Control-Request-Headers': 'range' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(ok.headers.get('Access-Control-Allow-Headers')).toContain('Range');
    const evil = await call(`/m/${await token()}`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('PRD §11: token authorization', () => {
  it('guessed R2 key / missing token → 401 without touching R2', async () => {
    for (const path of [
      `/m/${originalKey(OWNER, GALLERY, MEDIA)}`,
      `/m/${derivativeKey(GALLERY, MEDIA, 'w640v1')}`,
      '/m/',
      '/m/not-a-token',
    ]) {
      await expectGenericFailure(await call(path), 401);
    }
    r2Untouched();
  });

  it('expired token → 401, no bytes', async () => {
    const stale = await token(previewClaims, new Date(Date.now() - 10 * 60 * 1000));
    await expectGenericFailure(await call(`/m/${stale}`), 401);
    r2Untouched();
  });

  it('tampered token → 401', async () => {
    const [header, payload, sig] = (await token()).split('.') as [string, string, string];
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    const evil = btoa(
      JSON.stringify({ ...claims, media_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    await expectGenericFailure(await call(`/m/${header}.${evil}.${sig}`), 401);
    r2Untouched();
  });

  it('token from an unknown key → 401', async () => {
    const foreign = await signMediaToken(
      previewClaims,
      mediaTokenKeyringSchema.parse(`k1:${'x'.repeat(48)}`),
    );
    await expectGenericFailure(await call(`/m/${foreign}`), 401);
  });

  it('never logs the token', async () => {
    const t = await token();
    await call(`/m/${t}`);
    await call(`/m/${t.slice(0, -3)}abc`);
    expect(h.logs.join('\n')).not.toContain(t.split('.')[2]);
  });
});

describe('PRD §11: gallery access state', () => {
  it('password change (access_version bump) → 403 within the 5 s memo window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    const t = await token();
    expect((await call(`/m/${t}`)).status).toBe(200);

    setState({ ...baseState, accessVersion: 2 });
    // Documented staleness bound: the isolate memo may serve the old state for < 5 s ...
    vi.setSystemTime(new Date('2026-11-05T12:00:04.900Z'));
    expect((await call(`/m/${t}`)).status).toBe(200);
    // ... and never longer.
    vi.setSystemTime(new Date('2026-11-05T12:00:05Z'));
    await expectGenericFailure(await call(`/m/${t}`), 403);
  });

  it('gallery deleted mid-session → 404 on new requests', async () => {
    const t = await token(originalClaims);
    expect((await call(`/m/${t}`, { headers: { Range: 'bytes=0-99' } })).status).toBe(206);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5_000);
    setState({ ...baseState, deleted: true });
    await expectGenericFailure(await call(`/m/${t}`, { headers: { Range: 'bytes=100-199' } }), 404);
  });

  it('missing access state → 404 (fail closed)', async () => {
    setState(null);
    await expectGenericFailure(await call(`/m/${await token()}`), 404);
    r2Untouched();
  });

  it('expired gallery → 403', async () => {
    setState({ ...baseState, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expectGenericFailure(await call(`/m/${await token()}`), 403);
    r2Untouched();
  });

  it('delivery suspended → 403', async () => {
    setState({ ...baseState, deliverySuspended: true });
    await expectGenericFailure(await call(`/m/${await token()}`), 403);
  });

  it('KV unavailable → 503 fail closed, R2 never read', async () => {
    h.kv.fail = true;
    const res = await call(`/m/${await token()}`);
    await expectGenericFailure(res, 503);
    expect(res.headers.get('Retry-After')).toBe('5');
    r2Untouched();
  });

  describe('owner-scoped previews (editor thumbnails)', () => {
    const ownerPreview: MediaTokenInput = { ...previewClaims, scope: 'owner' };

    it('draft (no access state) → served to owner previews only', async () => {
      setState(null);
      const res = await call(`/m/${await token(ownerPreview)}`);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PREVIEW_BYTES);
      expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
    });

    it('expired gallery → still served to the owner, not to recipients', async () => {
      setState({ ...baseState, expiresAt: new Date(Date.now() - 1000).toISOString() });
      expect((await call(`/m/${await token(ownerPreview)}`)).status).toBe(200);
      await expectGenericFailure(await call(`/m/${await token()}`), 403);
    });

    it('deleted, revoked or suspended galleries deny owner previews too', async () => {
      setState({ ...baseState, deleted: true });
      await expectGenericFailure(await call(`/m/${await token(ownerPreview)}`), 404);
      setState({ ...baseState, accessVersion: 2 });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 5_000);
      await expectGenericFailure(await call(`/m/${await token(ownerPreview)}`), 403);
      setState({ ...baseState, deliverySuspended: true });
      vi.setSystemTime(Date.now() + 5_000);
      await expectGenericFailure(await call(`/m/${await token(ownerPreview)}`), 403);
      r2Untouched();
    });

    it('the owner scope exists only on previews: originals stay fail-closed for drafts', async () => {
      setState(null);
      // `scope` is not part of the original-claims schema, so it is stripped when signing.
      const t = await token({ ...originalClaims, scope: 'owner' } as unknown as MediaTokenInput);
      await expectGenericFailure(await call(`/m/${t}`), 404);
      r2Untouched();
    });
  });

  it('corrupt access state → 503 fail closed', async () => {
    h.kv.data.set(`gallery:${GALLERY}`, '{"accessVersion":"1"}');
    await expectGenericFailure(await call(`/m/${await token()}`), 503);
    r2Untouched();
  });
});

describe('serving previews', () => {
  it('streams the derivative inline with private short-lived caching', async () => {
    const t = await token();
    const res = await call(`/m/${t}`, { headers: { Origin: APP } });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PREVIEW_BYTES);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(res.headers.get('Content-Disposition')).toBe('inline');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('ETag')).toMatch(/^".+"$/);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(res.headers.get('Vary')).toContain('Origin');
    // Single R2 operation on the fast path.
    expect(h.derivatives.calls).toHaveLength(1);
  });

  it('does not grant CORS to other origins', async () => {
    const res = await call(`/m/${await token()}`, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('serves non-image derivative metadata as opaque bytes', async () => {
    h.derivatives.put(derivativeKey(GALLERY, MEDIA, 'w640v1'), PREVIEW_BYTES, 'text/html');
    const res = await call(`/m/${await token()}`);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('404s when the object does not exist', async () => {
    const t = await token({ ...previewClaims, variant_hash: 'missing1' } as MediaTokenInput);
    await expectGenericFailure(await call(`/m/${t}`), 404);
  });
});

describe('conditional and range requests', () => {
  it('returns 304 for a matching If-None-Match', async () => {
    const t = await token();
    const first = await call(`/m/${t}`);
    const etag = first.headers.get('ETag') as string;

    const res = await call(`/m/${t}`, { headers: { 'If-None-Match': `W/${etag}` } });
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get('ETag')).toBe(etag);

    const miss = await call(`/m/${t}`, { headers: { 'If-None-Match': '"other"' } });
    expect(miss.status).toBe(200);
  });

  it.each([
    ['bytes=0-9', 0, 9],
    ['bytes=990-', 990, 999],
    ['bytes=-5', 995, 999],
    ['bytes=500-5000', 500, 999],
  ])('serves %s as 206', async (range, start, end) => {
    const t = await token(originalClaims);
    const res = await call(`/m/${t}`, { headers: { Range: range } });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/1000`);
    expect(res.headers.get('Content-Length')).toBe(String(end - start + 1));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ORIGINAL_BYTES.slice(start, end + 1));
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const res = await call(`/m/${await token(originalClaims)}`, {
      headers: { Range: 'bytes=1000-' },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */1000');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('ignores multi-range and mismatched If-Range, serving the full object', async () => {
    const t = await token(originalClaims);
    const multi = await call(`/m/${t}`, { headers: { Range: 'bytes=0-1,5-6' } });
    expect(multi.status).toBe(200);
    expect(multi.headers.get('Content-Length')).toBe('1000');
    const ifRange = await call(`/m/${t}`, {
      headers: { Range: 'bytes=0-9', 'If-Range': '"stale"' },
    });
    expect(ifRange.status).toBe(200);
  });

  it('HEAD returns headers only', async () => {
    const res = await call(`/m/${await token(originalClaims)}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('1000');
    expect(await res.text()).toBe('');
  });
});

describe('downloads', () => {
  it('serves the exact original as an attachment, never cached', async () => {
    const res = await call(`/m/${await token(originalClaims)}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ORIGINAL_BYTES);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="Wedding Day 001.JPG"; filename*=UTF-8''Wedding%20Day%20001.JPG`,
    );
  });

  it('sanitizes hostile and non-ASCII filenames', async () => {
    const hostile = await token({
      ...originalClaims,
      filename: '../../etc/..pa"ss‮gpj.exe\r\n',
    } as MediaTokenInput);
    const res = await call(`/m/${hostile}`);
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="pa_ss_gpj.exe"; filename*=UTF-8''pa_ss_gpj.exe`,
    );

    const unicode = await token({
      ...originalClaims,
      filename: 'Été 2026 📷.heic',
    } as MediaTokenInput);
    const res2 = await call(`/m/${unicode}`);
    expect(res2.headers.get('Content-Disposition')).toBe(
      `attachment; filename="_t_ 2026 __.heic"; filename*=UTF-8''%C3%89t%C3%A9%202026%20%F0%9F%93%B7.heic`,
    );
  });

  it('serves archive parts as .zip attachments', async () => {
    const res = await call(`/m/${await token(archiveClaims)}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ARCHIVE_BYTES);
    expect(res.headers.get('Content-Disposition')).toContain(
      `attachment; filename="lumra-archive-part-1.zip"`,
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('no delivery metering (ADR-008)', () => {
  it('serves media without a usage queue binding', async () => {
    expect('USAGE' in h.env).toBe(false);
    expect((await call(`/m/${await token()}`)).status).toBe(200);
    expect((await call(`/m/${await token(archiveClaims)}`)).status).toBe(200);
  });
});

describe('observability (T04)', () => {
  it('serves a sanitized /health: status, service and short commit only', async () => {
    const res = await call('/health');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok', service: 'media-gateway' });
    h.env = { ...h.env, COMMIT_SHA: '0123456789abcdef' } as Env;
    expect(await (await call('/health')).json()).toEqual({
      status: 'ok',
      service: 'media-gateway',
      commit: '0123456789ab',
    });
  });

  it('echoes a valid x-request-id on every response and replaces invalid ones', async () => {
    const served = await call(`/m/${await token()}`, { headers: { 'x-request-id': 'req-gw-1' } });
    expect(served.status).toBe(200);
    expect(served.headers.get('x-request-id')).toBe('req-gw-1');
    const denied = await call('/m/not.a.token', {
      headers: { 'x-request-id': 'bad id\twith tab' },
    });
    expect(denied.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const ray = await call('/originals/x', { headers: { 'cf-ray': '8d3f2a1b0c9e-IAD' } });
    expect(ray.headers.get('x-request-id')).toBe('8d3f2a1b0c9e-IAD');
  });

  it('logs structured JSON bound to the request ID', async () => {
    await call('/m/forged.token.value', { headers: { 'x-request-id': 'req-trace-10' } });
    const events = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(
      events.some((e) => e.requestId === 'req-trace-10' && e.service === 'media-gateway'),
    ).toBe(true);
    expect(events.every((e) => typeof e.ts === 'string' && typeof e.level === 'string')).toBe(true);
  });

  it('keeps Sentry uninitialised without a DSN', () => {
    expect(sentryOptions(h.env)).toBeUndefined();
    expect(
      sentryOptions({ ...h.env, SENTRY_DSN: 'https://k@o1.ingest.sentry.io/1' } as Env),
    ).toMatchObject({ enabled: true, sendDefaultPii: false });
  });
});
