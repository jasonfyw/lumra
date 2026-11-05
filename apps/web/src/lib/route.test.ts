import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notFound } from 'next/navigation';

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  setTag: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: sentry.captureException,
  withScope: (fn: (scope: { setTag: typeof sentry.setTag }) => void) =>
    fn({ setTag: sentry.setTag }),
}));

const { withRoute } = await import('./route');
const { ok, fail } = await import('./api');
const { GET: health } = await import('../app/api/health/route');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let lines: string[] = [];

beforeEach(() => {
  lines = [];
  const push = (line: unknown) => void lines.push(String(line));
  vi.spyOn(console, 'info').mockImplementation(push);
  vi.spyOn(console, 'warn').mockImplementation(push);
  vi.spyOn(console, 'error').mockImplementation(push);
  sentry.captureException.mockClear();
  sentry.setTag.mockClear();
});
afterEach(() => vi.restoreAllMocks());

const req = (headers: Record<string, string> = {}) =>
  new Request('https://lumra.test/api/x', { headers });

describe('withRoute', () => {
  it('generates a request ID, exposes it to the handler and echoes it in the header', async () => {
    let seen = '';
    const route = withRoute('GET /api/x', (_r, { requestId }) => {
      seen = requestId;
      return ok({ hello: 'world' }, requestId);
    });
    const res = await route(req(), undefined);
    expect(seen).toMatch(UUID);
    expect(res.headers.get('x-request-id')).toBe(seen);
    expect(await res.json()).toEqual({ data: { hello: 'world' }, error: null, requestId: seen });
  });

  it('reuses a valid inbound x-request-id and rejects an invalid one', async () => {
    const route = withRoute('GET /api/x', (_r, { requestId }) => ok(null, requestId));
    expect(
      (await route(req({ 'x-request-id': 'edge-req-42' }), undefined)).headers.get('x-request-id'),
    ).toBe('edge-req-42');
    const res = await route(req({ 'x-request-id': '<script>alert(1)</script>' }), undefined);
    expect(res.headers.get('x-request-id')).toMatch(UUID);
  });

  it('converts unexpected errors into the internal envelope without leaking details', async () => {
    const route = withRoute('POST /api/x', () => {
      throw new Error(
        'connect ECONNREFUSED postgres://admin:hunter2@10.1.2.3:5432/db for jane@example.com',
      );
    });
    const res = await route(req({ 'x-request-id': 'req-boom-1' }), undefined);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      data: null,
      error: { code: 'internal', message: 'An unexpected error occurred.', retryable: true },
      requestId: 'req-boom-1',
    });
    expect(res.headers.get('x-request-id')).toBe('req-boom-1');
    expect(res.headers.get('cache-control')).toBe('no-store');

    // Reported to Sentry, tagged with the request ID for correlation.
    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(sentry.setTag).toHaveBeenCalledWith('requestId', 'req-boom-1');

    // Logged as structured JSON, correlated, with secrets redacted.
    const output = lines.join('\n');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('jane@example.com');
    expect(output).not.toContain('10.1.2.3');
    const events = lines.map((l) => JSON.parse(l));
    const err = events.find((e) => e.msg === 'unhandled route error');
    expect(err).toMatchObject({
      level: 'error',
      service: 'web',
      requestId: 'req-boom-1',
      route: 'POST /api/x',
    });
    expect(err.err.message).toContain('ECONNREFUSED');
  });

  it('passes expected API errors through untouched', async () => {
    const route = withRoute('GET /api/x', (_r, { requestId }) =>
      fail({ code: 'not_found', message: 'Gallery not found', retryable: false }, requestId),
    );
    const res = await route(req(), undefined);
    expect(res.status).toBe(404);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('rethrows Next.js control-flow errors such as notFound()', async () => {
    const route = withRoute('GET /api/x', () => notFound());
    await expect(route(req(), undefined)).rejects.toThrow();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('sets the header on responses with immutable headers', async () => {
    const immutable = Response.redirect('https://lumra.test/elsewhere', 302);
    const route = withRoute('GET /api/x', () => immutable);
    const res = await route(req({ 'x-request-id': 'req-imm' }), undefined);
    expect(res.status).toBe(302);
    expect(res.headers.get('x-request-id')).toBe('req-imm');
  });

  it('logs one completion line with method, status and duration', async () => {
    const route = withRoute('GET /api/x', (_r, { requestId }) => ok(null, requestId));
    await route(req({ 'x-request-id': 'req-log' }), undefined);
    const done = lines.map((l) => JSON.parse(l)).find((e) => e.msg === 'request completed');
    expect(done).toMatchObject({ level: 'info', requestId: 'req-log', method: 'GET', status: 200 });
    expect(typeof done.durationMs).toBe('number');
  });
});

describe('GET /api/health', () => {
  it('returns only status, service and (when set) the short commit SHA', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '0123456789abcdef0123456789abcdef01234567');
    try {
      const res = await health(req(), undefined);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body.data).toEqual({ status: 'ok', service: 'web', commit: '0123456789ab' });
      expect(body.requestId).toBe(res.headers.get('x-request-id'));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('omits the commit when not deployed', async () => {
    const body = await (await health(req(), undefined)).json();
    expect(body.data).toEqual({ status: 'ok', service: 'web' });
  });
});
