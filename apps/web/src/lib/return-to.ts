/**
 * Post-sign-in navigation intent (T05, FR-A04). Everything here is pure so it can run in the
 * proxy, route handlers, server actions and tests.
 *
 * `returnTo` is only ever a same-origin relative path: absolute URLs, protocol-relative `//host`,
 * backslash tricks (`/\host`), control characters and auth routes themselves are rejected and
 * replaced by the fallback, so sign-in can never become an open redirect.
 */
export const DEFAULT_RETURN_TO = '/dashboard';
export const AUTH_INTENTS = ['publish'] as const;
export type AuthIntent = (typeof AUTH_INTENTS)[number];

const MAX_RETURN_TO_LENGTH = 512;
const PROBE_ORIGIN = 'https://return-to.invalid';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function safeReturnTo(raw: unknown, fallback: string = DEFAULT_RETURN_TO): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_TO_LENGTH) {
    return fallback;
  }
  // Must be a rooted path; `//x` and `/\x` are treated as protocol-relative by browsers.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  // Never bounce back into the auth flow itself (loops, or replaying a consumed token_hash).
  if (url.pathname === '/auth' || url.pathname.startsWith('/auth/')) return fallback;
  if (url.pathname.startsWith('/api/')) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function parseAuthIntent(raw: unknown): AuthIntent | null {
  return typeof raw === 'string' && (AUTH_INTENTS as readonly string[]).includes(raw)
    ? (raw as AuthIntent)
    : null;
}

export function parseGalleryId(raw: unknown): string | null {
  return typeof raw === 'string' && UUID.test(raw) ? raw.toLowerCase() : null;
}

export interface AuthFlowParams {
  returnTo: string;
  intent: AuthIntent | null;
  /** Guest draft to claim after sign-in (only meaningful with intent=publish). */
  galleryId: string | null;
}

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function read(source: ParamSource, key: string): string | undefined {
  if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
  const value = source[key];
  return Array.isArray(value) ? value[0] : value;
}

export function parseAuthFlowParams(source: ParamSource): AuthFlowParams {
  const intent = parseAuthIntent(read(source, 'intent'));
  return {
    returnTo: safeReturnTo(read(source, 'returnTo')),
    intent,
    galleryId: intent ? parseGalleryId(read(source, 'galleryId')) : null,
  };
}

/** Query string that carries the flow through `/auth`, `/auth/confirm` and the email link. */
export function authFlowQuery(params: AuthFlowParams): URLSearchParams {
  const query = new URLSearchParams({ returnTo: params.returnTo });
  if (params.intent) query.set('intent', params.intent);
  if (params.intent && params.galleryId) query.set('galleryId', params.galleryId);
  return query;
}

/**
 * Where a freshly signed-in user goes. A publish intent lands on `/auth` again, which (now
 * signed in) runs the claim step; that step needs the guest cookie of THIS browser (FR-A04).
 */
export function postSignInPath(params: AuthFlowParams): string {
  if (params.intent === 'publish' && params.galleryId) return `/auth?${authFlowQuery(params)}`;
  return params.returnTo;
}

/**
 * Flow params for `/auth/confirm`. A customised email template passes the original
 * `emailRedirectTo` as an absolute `next` URL (`…/auth/confirm?returnTo=…`); it is unwrapped only
 * when it is on our own origin. Otherwise the params are read from the confirm URL directly.
 */
export function parseConfirmFlowParams(search: URLSearchParams, appOrigin: string): AuthFlowParams {
  const next = search.get('next');
  if (next) {
    try {
      const url = new URL(next, appOrigin);
      if (url.origin === appOrigin) {
        if (url.pathname === '/auth/confirm') return parseAuthFlowParams(url.searchParams);
        return {
          returnTo: safeReturnTo(`${url.pathname}${url.search}`),
          intent: null,
          galleryId: null,
        };
      }
    } catch {
      // fall through to the plain params
    }
  }
  return parseAuthFlowParams(search);
}
