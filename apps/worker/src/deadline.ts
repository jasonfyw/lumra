/**
 * Deadlines for everything the job Worker awaits (DB, R2, processor). A step that has not settled
 * in time rejects with `DeadlineExceededError`; the queue then retries the message quickly instead
 * of the invocation hanging until Cloudflare kills it at the wall-time limit.
 *
 * The underlying promise is not cancelled (postgres.js queries can't be aborted mid-flight); the
 * caller abandons it, and `Services.close()` tears the connections down with a short timeout.
 */

/** Per-step and per-unit-of-work budgets (ms). */
export const DEADLINES = {
  /** One DB round trip / repository call. */
  dbStepMs: 15_000,
  /** One R2 get/put. */
  r2StepMs: 20_000,
  /**
   * Whole job (load → read → process → write → complete). Above the processor client timeout
   * (`PROCESSOR_LIMITS.clientTimeoutMs`, 90 s) so a legitimately slow decode is not cut short.
   */
  jobMs: 120_000,
  /** One outbox relay pass (claim → publish → mark). */
  relayPassMs: 20_000,
  /** A cron tick keeps relaying until this much wall time has passed. */
  relayTickMs: 55_000,
  /** `sql.end({ timeout })` in seconds. */
  closeSeconds: 2,
} as const;

export class DeadlineExceededError extends Error {
  constructor(
    readonly step: string,
    readonly ms: number,
  ) {
    super(`deadline exceeded: ${step} after ${ms} ms`);
    this.name = 'DeadlineExceededError';
  }
}

export function isDeadlineExceeded(error: unknown): error is DeadlineExceededError {
  return error instanceof DeadlineExceededError;
}

/**
 * Resolves/rejects with `work`, or rejects with `DeadlineExceededError` after `ms`. `work` may be
 * a function receiving an `AbortSignal` that fires at the deadline (for fetch-like APIs).
 * An already-aborted `parent` signal (e.g. the job deadline) rejects immediately.
 */
export async function withDeadline<T>(
  step: string,
  ms: number,
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  parent?: AbortSignal,
): Promise<T> {
  const parentError = () =>
    parent?.reason instanceof Error ? parent.reason : new DeadlineExceededError(step, ms);
  if (parent?.aborted) {
    if (typeof work !== 'function') work.catch(() => {});
    throw parentError();
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    const fire = (error: Error) => {
      controller.abort(error);
      reject(error);
    };
    timer = setTimeout(() => fire(new DeadlineExceededError(step, ms)), ms);
    if (parent) {
      onParentAbort = () => fire(parentError());
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  });
  try {
    const promise = typeof work === 'function' ? work(controller.signal) : work;
    // Abandoned work must not surface as an unhandled rejection later.
    promise.catch(() => {});
    return await Promise.race([promise, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (parent && onParentAbort) parent.removeEventListener('abort', onParentAbort);
  }
}

/** An AbortSignal that fires `DeadlineExceededError(step)` after `ms`, with a `cancel` to stop it. */
export function deadlineSignal(step: string, ms: number): { signal: AbortSignal; cancel(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineExceededError(step, ms)), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}
