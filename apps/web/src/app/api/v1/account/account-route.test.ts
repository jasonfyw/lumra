import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-free authorization tests for `PATCH /api/v1/account` (display name). Supabase and the DB are
 * stubbed; the update's target row is captured so the test can prove it is the session's own user.
 */
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  updates: [] as { set: unknown; userId: unknown }[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({
  captureException: () => {},
  withScope: (fn: (scope: { setTag: () => void }) => void) => fn({ setTag: () => {} }),
}));
vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => true,
  createSupabaseServerClient: async () => ({
    auth: {
      getUser: async () =>
        state.user
          ? { data: { user: state.user }, error: null }
          : { data: { user: null }, error: { status: 400 } },
    },
  }),
}));
vi.mock('@/lib/rate-limit', () => ({ enforceRateLimit: vi.fn(async () => {}) }));
vi.mock('drizzle-orm', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  eq: (_column: unknown, value: unknown) => ({ eqValue: value }),
}));
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    update: () => ({
      set: (set: unknown) => ({
        where: async (cond: { eqValue: unknown }) => {
          state.updates.push({ set, userId: cond.eqValue });
        },
      }),
    }),
  }),
}));

const { resetServerEnvForTests } = await import('@/lib/env');
const { PATCH } = await import('./route');

const ME = '6f1c1a5e-1d2b-4c3a-9e8f-0a1b2c3d4e5f';
const OTHER = '0d9c5a52-7f4e-4a63-8f27-5d6b1c3e9a10';

const patch = (body: unknown, origin?: string) =>
  new Request('https://lumra.test/api/v1/account', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  state.user = null;
  state.updates = [];
  process.env.NEXT_PUBLIC_APP_URL = 'https://lumra.test';
  resetServerEnvForTests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('PATCH /api/v1/account', () => {
  it('401 without a signed-in user, and writes nothing', async () => {
    const res = await PATCH(patch({ name: 'Mallory' }), {});
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
    expect(state.updates).toEqual([]);
  });

  it('403 for a cross-origin request, even when signed in', async () => {
    state.user = { id: ME, email: 'a@example.test' };
    const res = await PATCH(patch({ name: 'Ada' }, 'https://evil.example'), {});
    expect(res.status).toBe(403);
    expect(state.updates).toEqual([]);
  });

  it('422 for an over-long name, a non-string name, or extra keys (no user id accepted)', async () => {
    state.user = { id: ME, email: 'a@example.test' };
    for (const body of [
      { name: 'x'.repeat(81) },
      { name: 42 },
      { name: 'Ada', userId: OTHER },
      { name: 'Ada', email: 'x@example.test' },
    ]) {
      const res = await PATCH(patch(body, 'https://lumra.test'), {});
      expect(res.status).toBe(422);
    }
    expect(state.updates).toEqual([]);
  });

  it("updates only the session user's own profile, never another user's", async () => {
    state.user = { id: ME, email: 'a@example.test' };
    const res = await PATCH(patch({ name: '  Ada Lovelace ' }, 'https://lumra.test'), {});
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ name: 'Ada Lovelace' });
    expect(state.updates).toEqual([{ set: { displayName: 'Ada Lovelace' }, userId: ME }]);
  });

  it('clears the name to null for a blank string', async () => {
    state.user = { id: ME, email: 'a@example.test' };
    const res = await PATCH(patch({ name: '   ' }, 'https://lumra.test'), {});
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ name: null });
    expect(state.updates).toEqual([{ set: { displayName: null }, userId: ME }]);
  });
});
