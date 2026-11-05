import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-free tests for the auth surface (T05) and the authentication gates of the T07/T08
 * endpoints. Supabase is stubbed; DB-backed authorization lives in apps/web/test-db.
 */
const auth = vi.hoisted(() => ({
  configured: true,
  user: null as null | { id: string; email: string },
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  signInWithOtp: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({
  captureException: () => {},
  withScope: (fn: (scope: { setTag: () => void }) => void) => fn({ setTag: () => {} }),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));
vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => auth.configured,
  createSupabaseServerClient: async () =>
    auth.configured
      ? {
          auth: {
            getUser: async () =>
              auth.user
                ? { data: { user: auth.user }, error: null }
                : { data: { user: null }, error: { status: 400 } },
            verifyOtp: auth.verifyOtp,
            exchangeCodeForSession: auth.exchangeCodeForSession,
            signInWithOtp: auth.signInWithOtp,
          },
        }
      : null,
}));
vi.mock('@/lib/db', () => ({
  getDb: () => {
    throw new Error('DB must not be reached before authentication');
  },
}));

process.env.NEXT_PUBLIC_APP_URL = 'https://lumra.test';

const { GET: confirm } = await import('./confirm/route');
const { GET: listGalleries, POST: createGallery } = await import('../api/v1/galleries/route');
const { POST: claim } = await import('../api/v1/guest/drafts/claim/route');
const { sendOtpAction, verifyOtpAction } = await import('./actions');

const GALLERY = '6f1c1a5e-1d2b-4c3a-9e8f-0a1b2c3d4e5f';

beforeEach(() => {
  auth.configured = true;
  auth.user = null;
  auth.verifyOtp.mockReset();
  auth.exchangeCodeForSession.mockReset();
  auth.signInWithOtp.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GET /auth/confirm', () => {
  it('verifies token_hash and redirects to the validated returnTo', async () => {
    auth.verifyOtp.mockResolvedValue({ error: null });
    const res = await confirm(
      new Request(
        'https://lumra.test/auth/confirm?token_hash=abc&type=email&returnTo=%2Fdashboard',
      ),
      {},
    );
    expect(auth.verifyOtp).toHaveBeenCalledWith({ type: 'email', token_hash: 'abc' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://lumra.test/dashboard');
  });

  it('never redirects off-origin, whatever returnTo or next say', async () => {
    auth.verifyOtp.mockResolvedValue({ error: null });
    for (const q of [
      'returnTo=https%3A%2F%2Fevil.example',
      'returnTo=%2F%2Fevil.example',
      'next=https%3A%2F%2Fevil.example%2Fx',
    ]) {
      const res = await confirm(
        new Request(`https://lumra.test/auth/confirm?token_hash=abc&type=email&${q}`),
        {},
      );
      expect(new URL(res.headers.get('location')!).origin).toBe('https://lumra.test');
      expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard');
    }
  });

  it('routes a publish intent to the claim step', async () => {
    auth.verifyOtp.mockResolvedValue({ error: null });
    const next = encodeURIComponent(
      `https://lumra.test/auth/confirm?returnTo=%2Fnew&intent=publish&galleryId=${GALLERY}`,
    );
    const res = await confirm(
      new Request(`https://lumra.test/auth/confirm?token_hash=abc&type=email&next=${next}`),
      {},
    );
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/auth');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      returnTo: '/new',
      intent: 'publish',
      galleryId: GALLERY,
    });
  });

  it('exchanges a PKCE code', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ error: null });
    const res = await confirm(new Request('https://lumra.test/auth/confirm?code=xyz'), {});
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('xyz');
    expect(res.headers.get('location')).toBe('https://lumra.test/dashboard');
  });

  it('sends invalid/expired links back to /auth with an error, keeping the intent', async () => {
    auth.verifyOtp.mockResolvedValue({ error: { code: 'otp_expired', status: 403 } });
    const res = await confirm(
      new Request('https://lumra.test/auth/confirm?token_hash=old&type=email&returnTo=%2Fnew'),
      {},
    );
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/auth');
    expect(location.searchParams.get('error')).toBe('link_invalid');
    expect(location.searchParams.get('returnTo')).toBe('/new');
    // Unknown OTP types and missing params are rejected without calling Supabase.
    auth.verifyOtp.mockClear();
    await confirm(new Request('https://lumra.test/auth/confirm?token_hash=x&type=recovery'), {});
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
});

describe('auth server actions', () => {
  const state = { step: 'email' as const, email: '', error: null, notice: null, sentAt: null };
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };

  it('sends an OTP with emailRedirectTo on our origin carrying the validated intent', async () => {
    auth.signInWithOtp.mockResolvedValue({ error: null });
    const next = await sendOtpAction(
      state,
      form({
        email: ' Person@Example.com ',
        returnTo: 'https://evil.example',
        intent: 'publish',
        galleryId: GALLERY,
      }),
    );
    expect(next).toMatchObject({ step: 'code', email: 'person@example.com', error: null });
    const [{ email, options }] = auth.signInWithOtp.mock.calls[0]!;
    expect(email).toBe('person@example.com');
    const redirect = new URL(options.emailRedirectTo);
    expect(redirect.origin + redirect.pathname).toBe('https://lumra.test/auth/confirm');
    expect(redirect.searchParams.get('returnTo')).toBe('/dashboard');
    expect(redirect.searchParams.get('intent')).toBe('publish');
    expect(redirect.searchParams.get('galleryId')).toBe(GALLERY);
  });

  it('returns accessible, non-leaky errors', async () => {
    expect((await sendOtpAction(state, form({ email: 'nope' }))).error).toMatch(/valid email/);
    auth.signInWithOtp.mockResolvedValue({
      error: { status: 429, code: 'over_email_send_rate_limit', message: 'internal detail' },
    });
    const limited = await sendOtpAction(state, form({ email: 'a@b.co' }));
    expect(limited.error).toMatch(/Too many/);
    expect(limited.error).not.toContain('internal detail');

    const codeState = { ...state, step: 'code' as const, email: 'a@b.co' };
    expect((await verifyOtpAction(codeState, form({ email: 'a@b.co', code: '12' }))).error).toMatch(
      /6-digit/,
    );
    auth.verifyOtp.mockResolvedValue({ error: { status: 403, code: 'otp_expired' } });
    const expired = await verifyOtpAction(codeState, form({ email: 'a@b.co', code: '123456' }));
    expect(expired.error).toMatch(/incorrect or has expired/);
  });

  it('redirects to the claim step after a successful verify', async () => {
    auth.verifyOtp.mockResolvedValue({ error: null });
    await expect(
      verifyOtpAction(
        { ...state, step: 'code', email: 'a@b.co' },
        form({
          email: 'a@b.co',
          code: '123 456',
          returnTo: '/new',
          intent: 'publish',
          galleryId: GALLERY,
        }),
      ),
    ).rejects.toMatchObject({
      digest: expect.stringContaining(`/auth?returnTo=%2Fnew&intent=publish&galleryId=${GALLERY}`),
    });
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: 'a@b.co',
      token: '123456',
      type: 'email',
    });
  });

  it('degrades gracefully without Supabase env', async () => {
    auth.configured = false;
    expect((await sendOtpAction(state, form({ email: 'a@b.co' }))).error).toMatch(/not available/);
  });
});

describe('endpoint authentication gates (before any DB access)', () => {
  const req = (url: string, method = 'POST') =>
    new Request(`https://lumra.test${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ galleryId: GALLERY }) : undefined,
    });

  it('401 for unauthenticated list, create and claim', async () => {
    for (const res of [
      await listGalleries(req('/api/v1/galleries', 'GET'), {}),
      await createGallery(req('/api/v1/galleries'), {}),
      await claim(req('/api/v1/guest/drafts/claim'), {}),
    ]) {
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe('unauthenticated');
    }
  });

  it('401 when Supabase is not configured at all', async () => {
    auth.configured = false;
    expect((await claim(req('/api/v1/guest/drafts/claim'), {})).status).toBe(401);
  });
});
