import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeadlineExceededError,
  deadlineSignal,
  isDeadlineExceeded,
  withDeadline,
} from './deadline';
import { bounded, type StepTimings } from './instrument';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('withDeadline', () => {
  it('resolves with the work when it settles in time', async () => {
    await expect(withDeadline('fast', 100, Promise.resolve(42))).resolves.toBe(42);
  });

  it('passes through the work rejection', async () => {
    await expect(withDeadline('fails', 100, Promise.reject(new Error('nope')))).rejects.toThrow(
      'nope',
    );
  });

  it('rejects with DeadlineExceededError once the deadline passes', async () => {
    const result = withDeadline('db.claim', 1_000, new Promise(() => {}));
    const assertion = expect(result).rejects.toMatchObject({ step: 'db.claim', ms: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    await result.catch((e: unknown) => {
      expect(isDeadlineExceeded(e)).toBe(true);
      expect((e as Error).message).toBe('deadline exceeded: db.claim after 1000 ms');
    });
  });

  it('aborts the signal handed to function-style work', async () => {
    let seen: AbortSignal | undefined;
    const result = withDeadline('fetch', 500, (signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    result.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(DeadlineExceededError);
  });

  it('rejects as soon as the parent deadline fires, with the parent reason', async () => {
    const parent = deadlineSignal('job', 200);
    const result = withDeadline('db.step', 10_000, new Promise(() => {}), parent.signal);
    const assertion = expect(result).rejects.toMatchObject({ step: 'job', ms: 200 });
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });

  it('rejects immediately for an already-aborted parent', async () => {
    const controller = new AbortController();
    controller.abort(new DeadlineExceededError('job', 1));
    await expect(
      withDeadline('db.step', 10_000, Promise.resolve(1), controller.signal),
    ).rejects.toMatchObject({ step: 'job' });
  });

  it('clears its timer when the work wins (no late rejection)', async () => {
    await withDeadline('quick', 1_000, Promise.resolve('ok'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deadlineSignal can be cancelled', () => {
    const d = deadlineSignal('x', 100);
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(d.signal.aborted).toBe(false);
  });
});

describe('bounded', () => {
  it('times each method call and records its duration', async () => {
    let clock = 0;
    const timings: StepTimings = {};
    const repo = {
      load: async (id: string) => {
        clock += 7;
        return `row-${id}`;
      },
      name: 'repo',
    };
    const wrapped = bounded(repo, 'db', 1_000, { timings, now: () => clock });
    expect(await wrapped.load('a')).toBe('row-a');
    await wrapped.load('b');
    expect(wrapped.name).toBe('repo');
    expect(timings).toEqual({ 'db.load': 14 });
  });

  it('rejects a hung call with a step-named deadline error', async () => {
    const wrapped = bounded({ get: () => new Promise<never>(() => {}) }, 'r2', 300);
    const assertion = expect(wrapped.get()).rejects.toMatchObject({ step: 'r2.get', ms: 300 });
    await vi.advanceTimersByTimeAsync(300);
    await assertion;
  });
});
