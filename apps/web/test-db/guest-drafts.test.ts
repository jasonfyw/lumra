/**
 * T06: guest drafts (FR-A01..A03) and the Postgres rate limiter (FR-A05), through the real
 * route handlers against the local Supabase DB.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GUEST_LIMITS, RATE_LIMITS } from '@lumra/config';
import { GET as currentDraft } from '@/app/api/v1/guest/drafts/current/route';
import { hashGuestCapability } from '@/lib/guest-capability';
import { enforceRateLimit, turnstileVerifier } from '@/lib/rate-limit';
import { ApiFailure } from '@/lib/api';
import { POST as createDraft } from '@/app/api/v1/guest/drafts/route';
import { actAs, cleanup, freshIp, jsonRequest, newDraft, readJson, sql } from './helpers';

afterEach(cleanup);
afterAll(() => sql.end());

describe('POST /api/v1/guest/drafts', () => {
  it('creates a session + draft in one go and sets the HttpOnly SameSite=Lax cookie', async () => {
    const before = Date.now();
    const { res, setCookie, capability, body, guestSessionId } = await newDraft();
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Secure/i); // Secure only in production
    expect(JSON.stringify(body)).not.toContain(capability);

    const expires = new Date(body.data.draftExpiresAt).getTime();
    expect(expires - before).toBeGreaterThan(GUEST_LIMITS.draftTtlMs - 60_000);
    expect(expires - before).toBeLessThan(GUEST_LIMITS.draftTtlMs + 60_000);

    const [session] = await sql<{ capability_hash: string; rate_key_hash: string }[]>`
      select capability_hash, rate_key_hash from public.guest_sessions where id = ${guestSessionId}`;
    expect(session!.capability_hash).toBe(
      await hashGuestCapability(capability, process.env.GUEST_CAPABILITY_PEPPER!),
    );
    expect(session!.capability_hash).not.toContain(capability);
    expect(session!.rate_key_hash).toMatch(/^[0-9a-f]{32}$/);

    const [gallery] = await sql<
      { owner_id: string | null; title: string; status: string; slug: string }[]
    >`select owner_id, title, status, slug from public.galleries where id = ${body.data.galleryId}`;
    expect(gallery).toMatchObject({ owner_id: null, title: 'Untitled gallery', status: 'draft' });
    expect(gallery!.slug).toMatch(/^[1-9A-HJ-NP-Za-km-z]{17}$/);
  });

  it('returns the existing draft for a browser that already has one', async () => {
    const first = await newDraft();
    actAs({ guestCookie: first.capability });
    const res = await createDraft(jsonRequest('/api/v1/guest/drafts', {}), undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await readJson<{ galleryId: string }>(res)).data.galleryId).toBe(
      first.body.data.galleryId,
    );
  });

  it('rejects cross-origin requests', async () => {
    const res = await createDraft(
      jsonRequest('/api/v1/guest/drafts', {}, { headers: { origin: 'https://evil.example' } }),
      undefined,
    );
    expect(res.status).toBe(403);
  });

  it(`rate limits creation per client IP: 429 + Retry-After after ${RATE_LIMITS.guestDraftCreate.limit}`, async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < RATE_LIMITS.guestDraftCreate.limit; i++) {
      statuses.push((await newDraft(ip)).res.status);
    }
    expect(statuses.every((s) => s === 201)).toBe(true);
    const { res, body } = await newDraft(ip);
    expect(res.status).toBe(429);
    expect(body.error?.code).toBe('rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    // A different IP is unaffected.
    expect((await newDraft(freshIp())).res.status).toBe(201);

    // Only hashed keys are stored — never the raw IP.
    const rows = await sql<{ bucket_key: string }[]>`
      select bucket_key from public.rate_limit_buckets where bucket_key like 'guestDraftCreate:%'`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.bucket_key).toMatch(/^guestDraftCreate:[0-9a-f]{32}$/);
      expect(row.bucket_key).not.toContain(ip);
    }
  });
});

describe('GET /api/v1/guest/drafts/current', () => {
  const get = () => currentDraft(jsonRequest('/api/v1/guest/drafts/current'), undefined);

  it('404s without a cookie or with a malformed/unknown one', async () => {
    actAs({});
    expect((await get()).status).toBe(404);
    actAs({ guestCookie: 'not-a-capability' });
    expect((await get()).status).toBe(404);
    actAs({ guestCookie: 'A'.repeat(43) });
    expect((await get()).status).toBe(404);
  });

  it('returns the draft, quota and items (no secrets) for the cookie holder', async () => {
    const { capability, body, guestSessionId } = await newDraft();
    actAs({ guestCookie: capability });
    const res = await get();
    expect(res.status).toBe(200);
    const draft = await readJson<{
      gallery: { id: string; status: string };
      quota: Record<string, number>;
      media: unknown[];
      draftExpiresAt: string;
    }>(res);
    expect(draft.data.gallery).toMatchObject({ id: body.data.galleryId, status: 'draft' });
    expect(draft.data.quota).toEqual({
      reservedFiles: 0,
      reservedBytes: 0,
      maxFiles: 20,
      maxBytes: 250_000_000,
    });
    expect(draft.data.media).toEqual([]);
    const text = JSON.stringify(draft);
    expect(text).not.toContain(capability);
    expect(text).not.toContain(guestSessionId);
  });

  it('404s once the draft has expired or been claimed', async () => {
    const expired = await newDraft();
    await sql`update public.guest_sessions set expires_at = now() - interval '1 second'
              where id = ${expired.guestSessionId}`;
    actAs({ guestCookie: expired.capability });
    expect((await get()).status).toBe(404);

    const claimed = await newDraft();
    await sql`update public.guest_sessions set claimed_at = now() where id = ${claimed.guestSessionId}`;
    actAs({ guestCookie: claimed.capability });
    expect((await get()).status).toBe(404);
  });
});

describe('rate limiter + bot challenge hook', () => {
  const request = () => jsonRequest('/x', {});

  it('requires a valid Turnstile token above challengeAt, only when a verifier is configured', async () => {
    const subject = { kind: 'ip', ip: freshIp() } as const;
    const rule = { limit: 5, windowSeconds: 60, challengeAt: 1 };
    const verifier = vi.fn(async (token: string) => token === 'good');

    await enforceRateLimit(request(), 'guestDraftCreate', subject, { rule, challenge: verifier });
    expect(verifier).not.toHaveBeenCalled(); // below challengeAt

    const denied = await enforceRateLimit(request(), 'guestDraftCreate', subject, {
      rule,
      challenge: verifier,
    }).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ApiFailure);
    expect((denied as ApiFailure).error).toMatchObject({
      code: 'rate_limited',
      details: { challenge: 'turnstile' },
    });

    const withToken = jsonRequest('/x', {}, { headers: { 'x-turnstile-token': 'good' } });
    await expect(
      enforceRateLimit(withToken, 'guestDraftCreate', subject, { rule, challenge: verifier }),
    ).resolves.toBeUndefined();

    // No verifier configured (TURNSTILE_SECRET_KEY unset): no challenge, only the hard limit.
    await expect(
      enforceRateLimit(request(), 'guestDraftCreate', subject, { rule, challenge: null }),
    ).resolves.toBeUndefined();
    const limited = await enforceRateLimit(request(), 'guestDraftCreate', subject, {
      rule,
      challenge: null,
    })
      .then(() =>
        enforceRateLimit(request(), 'guestDraftCreate', subject, { rule, challenge: null }),
      )
      .catch((e: unknown) => e);
    expect((limited as ApiFailure).error.code).toBe('rate_limited');
    expect((limited as ApiFailure).headers['Retry-After']).toMatch(/^\d+$/);
  });

  it('counts concurrent hits atomically', async () => {
    const subject = { kind: 'user', userId: crypto.randomUUID() } as const;
    const rule = { limit: 10, windowSeconds: 3600 };
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () =>
        enforceRateLimit(request(), 'uploadIntent', subject, { rule, challenge: null }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
  });

  it('verifies Turnstile tokens server-side', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      return Response.json({
        success: form.get('response') === 'ok' && form.get('secret') === 's',
      });
    });
    const verify = turnstileVerifier('s', fetchImpl as unknown as typeof fetch);
    expect(await verify('ok', '192.0.2.1')).toBe(true);
    expect(await verify('bad', null)).toBe(false);
    expect(await verify('', null)).toBe(false);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
  });
});
