import type { ZodType } from 'zod';
import type { ApiError } from '@lumra/contracts';

/**
 * Cross-cutting checks for cookie-authenticated mutations (PRD §6.2 "Validate origin/anti-CSRF").
 * Auth and guest cookies are SameSite=Lax, so browsers don't attach them to cross-site
 * `fetch` POSTs; requiring JSON forces a CORS preflight for cross-origin callers, and an
 * explicit foreign `Origin` is refused outright.
 */
export function crossOriginError(request: Request, appUrl?: string): ApiError | null {
  const origin = request.headers.get('origin');
  if (!origin) return null; // same-origin navigations and non-browser clients
  const allowed = new Set([new URL(request.url).origin]);
  if (appUrl) allowed.add(new URL(appUrl).origin);
  if (allowed.has(origin)) return null;
  return { code: 'forbidden', message: 'Cross-origin request refused.', retryable: false };
}

export type ParsedBody<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** Parses an optional JSON body (empty body ⇒ `{}`) with a Zod schema. */
export async function parseJsonBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<ParsedBody<T>> {
  const type = request.headers.get('content-type') ?? '';
  const text = await request.text();
  if (text.length > 0 && !type.toLowerCase().startsWith('application/json')) {
    return { ok: false, error: validation('Body must be application/json.') };
  }
  let raw: unknown = {};
  if (text.length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, error: validation('Body is not valid JSON.') };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: validation('Request validation failed.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }),
    };
  }
  return { ok: true, data: parsed.data };
}

export function validation(message: string, details?: Record<string, unknown>): ApiError {
  return { code: 'validation_failed', message, retryable: false, ...(details ? { details } : {}) };
}

export const UNAUTHENTICATED: ApiError = {
  code: 'unauthenticated',
  message: 'Sign in to continue.',
  retryable: false,
};

export const NOT_FOUND: ApiError = { code: 'not_found', message: 'Not found.', retryable: false };

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;
