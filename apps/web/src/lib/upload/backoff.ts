/** Retry timing for uploads (FR-M03: "retry individual parts with jitter and capped backoff"). */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
}

export const DEFAULT_BACKOFF = { baseMs: 500, maxMs: 30_000 } as const;
/** Server-provided waits are honoured but never longer than this. */
export const MAX_RETRY_AFTER_MS = 120_000;

/**
 * Delay before retry number `attempt` (0-based): capped exponential with "equal jitter", i.e. a
 * uniformly random value in [cap/2, cap] where cap = min(maxMs, baseMs · 2^attempt). The floor
 * keeps a burst of failing parts from retrying immediately; the jitter spreads them out.
 */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  { baseMs = DEFAULT_BACKOFF.baseMs, maxMs = DEFAULT_BACKOFF.maxMs }: BackoffOptions = {},
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(cap / 2 + (cap / 2) * r);
}

/** `Retry-After` (delta-seconds or HTTP-date) → milliseconds, clamped; null when absent/invalid. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

/** Resolves after `ms`, or rejects with an `AbortError` as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
