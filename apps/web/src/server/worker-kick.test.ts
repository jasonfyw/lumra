import { createLogger } from '@lumra/observability';
import { describe, expect, it, vi } from 'vitest';
import { kickWorkerRelay, WORKER_KICK_TIMEOUT_MS } from './worker-kick';

const SECRET = 'kick-secret-0123456789abcdef0123456789abcdef';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    service: 'web',
    sink: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { log, lines };
}

describe('kickWorkerRelay', () => {
  it('skips when WORKER_URL or WORKER_KICK_SECRET is unset', async () => {
    const { log } = capture();
    const fetch = vi.fn();
    expect(await kickWorkerRelay({ log, secret: SECRET, fetch })).toBe('skipped');
    expect(await kickWorkerRelay({ log, workerUrl: 'https://w.test', fetch })).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('POSTs the bearer secret to /internal/relay with a short timeout', async () => {
    const { log } = capture();
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const outcome = await kickWorkerRelay({
      log,
      workerUrl: 'https://worker.test/',
      secret: SECRET,
      requestId: 'req-1',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(outcome).toBe('accepted');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://worker.test/internal/relay');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(new Headers(init.headers).get('x-request-id')).toBe('req-1');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(WORKER_KICK_TIMEOUT_MS).toBe(3_000);
  });

  it('swallows network errors and non-202 answers, logging a warning without secrets', async () => {
    const { log, lines } = capture();
    const failing = vi.fn(async () => {
      throw new TypeError(`fetch failed for https://worker.test (${SECRET})`);
    });
    expect(
      await kickWorkerRelay({
        log,
        workerUrl: 'https://worker.test',
        secret: SECRET,
        fetch: failing as unknown as typeof globalThis.fetch,
      }),
    ).toBe('failed');
    const rejected = vi.fn(async () => new Response('no', { status: 401 }));
    expect(
      await kickWorkerRelay({
        log,
        workerUrl: 'https://worker.test',
        secret: SECRET,
        fetch: rejected as unknown as typeof globalThis.fetch,
      }),
    ).toBe('failed');
    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      ['warn', 'worker relay kick failed'],
      ['warn', 'worker relay kick rejected'],
    ]);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('gives up after the timeout', async () => {
    const { log } = capture();
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );
    const outcome = await kickWorkerRelay({
      log,
      workerUrl: 'https://worker.test',
      secret: SECRET,
      timeoutMs: 20,
      fetch: hanging as unknown as typeof globalThis.fetch,
    });
    expect(outcome).toBe('failed');
  });
});
