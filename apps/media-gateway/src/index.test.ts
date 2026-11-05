import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { sentryOptions, type Env } from './index';

const env = { APP_ORIGIN: 'http://localhost:3000' } as Env;
const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;
const call = (path: string, init?: RequestInit, e: Env = env) =>
  worker.fetch(new Request(`https://media.example.test${path}`, init), e, ctx);

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  const push = (line: unknown) => void lines.push(String(line));
  vi.spyOn(console, 'error').mockImplementation(push);
  vi.spyOn(console, 'warn').mockImplementation(push);
  vi.spyOn(console, 'info').mockImplementation(push);
});
afterEach(() => vi.restoreAllMocks());

describe('media gateway', () => {
  it('reports sanitized health', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok', service: 'media-gateway' });
  });

  it('includes the short commit SHA when deployed with one', async () => {
    const res = await call('/health', undefined, { ...env, COMMIT_SHA: '0123456789abcdef' });
    expect(await res.json()).toEqual({
      status: 'ok',
      service: 'media-gateway',
      commit: '0123456789ab',
    });
  });

  it('fails closed for media paths without a valid token', async () => {
    const res = await call('/m/originals/some/guessed/key');
    expect(res.status).toBe(401);
  });

  it('rejects mutating methods', async () => {
    const res = await call('/m/x', { method: 'PUT' });
    expect(res.status).toBe(405);
  });

  it('echoes a valid x-request-id and generates one otherwise', async () => {
    const res = await call('/m/x', { headers: { 'x-request-id': 'req-gw-1' } });
    expect(res.headers.get('x-request-id')).toBe('req-gw-1');
    const gen = await call('/m/x', { headers: { 'x-request-id': 'bad value\twith tab' } });
    expect(gen.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('fails closed with 503 on invalid env without revealing details', async () => {
    const res = await call('/m/x', undefined, {
      ...env,
      APP_ORIGIN: 'not a url',
      MEDIA_TOKEN_SECRET: 'short',
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('Service Unavailable');
    const logged = lines.map((l) => JSON.parse(l)).find((e) => e.msg === 'invalid environment');
    expect(logged).toMatchObject({ level: 'error', service: 'media-gateway' });
    expect(lines.join('\n')).not.toContain('"short"');
  });

  it('never logs request paths', async () => {
    await call('/m/originals/user-123/gallery/media/source?token=abc', {
      headers: { 'x-request-id': 'req-quiet' },
    });
    expect(lines.join('\n')).not.toContain('user-123');
  });

  it('keeps Sentry uninitialised without a DSN', () => {
    expect(sentryOptions(env)).toBeUndefined();
    expect(sentryOptions({ ...env, SENTRY_DSN: 'https://k@o1.ingest.sentry.io/1' })).toMatchObject({
      enabled: true,
      sendDefaultPii: false,
    });
  });
});
