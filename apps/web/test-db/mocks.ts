/**
 * Vitest setup file: stubs the request-scoped Next.js/Supabase edges so route handlers can be
 * called directly. `getUser()` returns `ctx.user`; `cookies()` reads `ctx.cookies`.
 */
import { vi } from 'vitest';
import { ctx } from './context';

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      ctx.cookies.has(name) ? { name, value: ctx.cookies.get(name)! } : undefined,
    getAll: () => [...ctx.cookies].map(([name, value]) => ({ name, value })),
    set: () => {},
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => true,
  createSupabaseServerClient: async () => ({
    auth: {
      getUser: async () =>
        ctx.user
          ? { data: { user: ctx.user }, error: null }
          : { data: { user: null }, error: { message: 'Auth session missing', status: 400 } },
    },
  }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: () => {},
  withScope: (fn: (scope: { setTag: () => void }) => void) => fn({ setTag: () => {} }),
}));
