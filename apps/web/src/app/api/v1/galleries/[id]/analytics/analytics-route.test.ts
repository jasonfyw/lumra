import { beforeEach, describe, expect, it, vi } from 'vitest';

/** DB-free authorization tests for `GET /api/v1/galleries/{id}/analytics` (T26). */
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  guest: false,
  owner: '00000000-0000-4000-8000-0000000000aa',
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
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    execute: async () => [
      {
        owner_id: state.owner,
        view_count: '5',
        unique_visitor_count: '2',
        item_download_count: '1',
        archive_download_count: '1',
        last_viewed_at: null,
      },
    ],
  }),
}));
vi.mock('@/lib/env', () => ({
  serverEnv: () => ({ NEXT_PUBLIC_APP_URL: 'https://lumra.test' }),
}));

const { GET } = await import('./route');
const GALLERY = '11111111-1111-4111-8111-111111111111';
const call = () =>
  GET(new Request(`https://lumra.test/api/v1/galleries/${GALLERY}/analytics`), {
    params: Promise.resolve({ id: GALLERY }),
  });

beforeEach(() => {
  state.user = null;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/v1/galleries/[id]/analytics', () => {
  it('401 without a signed-in user', async () => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  it('404 (concealed) for a signed-in user who does not own the gallery', async () => {
    state.user = { id: '00000000-0000-4000-8000-0000000000bb', email: 'x@example.test' };
    const res = await call();
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('"views"');
  });

  it('200 with no-store counters for the owner', async () => {
    state.user = { id: state.owner, email: 'o@example.test' };
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = (await res.json()) as { data: { views: number; downloads: number } };
    expect(body.data).toMatchObject({ views: 5, downloads: 2 });
  });
});
