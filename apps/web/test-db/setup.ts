/**
 * Setup for route integration tests. Runs before each test file is imported.
 *
 * - Server env points at the local Supabase DB and the fake R2 endpoint.
 * - `next/headers` cookies() reads the per-test cookie jar in `testRequestState`.
 * - Supabase Auth `getUser()` returns `testRequestState.user` (sessions are verified by Supabase
 *   in production; here the test decides who is signed in).
 * - global `fetch` is the in-memory R2 fake.
 */
import { afterEach, vi } from 'vitest';
import { FakeR2, R2_ACCESS_KEY_ID, R2_BUCKET, R2_ENDPOINT, R2_SECRET_ACCESS_KEY } from './fake-r2';

Object.assign(process.env, {
  DATABASE_URL:
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  NEXT_PUBLIC_APP_URL: 'https://lumra.test',
  GUEST_CAPABILITY_PEPPER: 'test-guest-pepper-0123456789abcdef0123456789',
  R2_ACCOUNT_ID: 'testaccount',
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_ORIGINALS: R2_BUCKET,
  R2_ENDPOINT,
  LOG_LEVEL: 'error',
});
delete process.env.TURNSTILE_SECRET_KEY;
delete process.env.RATE_LIMIT_PEPPER;

export interface TestRequestState {
  cookies: Map<string, string>;
  user: { id: string; email: string } | null;
  r2: FakeR2;
}

const state: TestRequestState = { cookies: new Map(), user: null, r2: new FakeR2() };
(globalThis as { __lumraTestState?: TestRequestState }).__lumraTestState = state;

vi.stubGlobal('fetch', state.r2.fetch);

vi.mock('next/headers', () => {
  const s = () =>
    (globalThis as unknown as { __lumraTestState: TestRequestState }).__lumraTestState;
  return {
    cookies: async () => ({
      get: (name: string) => {
        const value = s().cookies.get(name);
        return value === undefined ? undefined : { name, value };
      },
      getAll: () => [...s().cookies].map(([name, value]) => ({ name, value })),
      has: (name: string) => s().cookies.has(name),
      set: () => undefined,
      delete: () => undefined,
    }),
    headers: async () => new Headers(),
  };
});

vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => true,
  createSupabaseServerClient: async () => ({
    auth: {
      getUser: async () => {
        const user = (globalThis as unknown as { __lumraTestState: TestRequestState })
          .__lumraTestState.user;
        return user
          ? { data: { user: { id: user.id, email: user.email } }, error: null }
          : { data: { user: null }, error: { message: 'no session' } };
      },
    },
  }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  withScope: (fn: (scope: { setTag: () => void }) => void) => fn({ setTag: () => undefined }),
}));

afterEach(() => {
  state.cookies.clear();
  state.user = null;
});
