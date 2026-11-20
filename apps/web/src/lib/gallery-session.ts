/**
 * Gallery password sessions (FR-G04, T19): a 256-bit random bearer token in an HttpOnly cookie.
 * Only its SHA-256 is stored (`gallery_access_sessions.token_hash`); a 256-bit random secret
 * needs no pepper to resist offline guessing. Sessions are bound to the gallery's
 * `access_version` at unlock time, so any password change/revocation invalidates them.
 *
 * The cookie is set twice with the same name and value, once per path that needs it, so the
 * browser sends it only to this gallery's page and this gallery's public API — never to other
 * galleries or the rest of the app.
 */
export const GALLERY_SESSION_COOKIE = 'lumra_gallery';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateGallerySessionToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isWellFormedSessionToken(value: string | undefined): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export async function hashGallerySessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Paths the session cookie is scoped to (the page and the public API of one gallery). */
export function gallerySessionCookiePaths(slug: string): string[] {
  const safe = encodeURIComponent(slug);
  return [`/g/${safe}`, `/api/v1/public/galleries/${safe}`];
}

/**
 * `Set-Cookie` header values (one per path). Built by hand because `NextResponse.cookies` keys
 * cookies by name only, so a second path would overwrite the first. The token alphabet is
 * cookie-safe (base64url) and paths are URI-encoded, so nothing here needs escaping.
 */
export function gallerySessionSetCookies(
  slug: string,
  token: string,
  expiresAt: Date,
  secure: boolean,
): string[] {
  return sessionSetCookies(gallerySessionCookiePaths(slug), token, expiresAt, secure);
}

/**
 * Paths an archive job's copy of the gallery session is scoped to (T24/T25): its progress page
 * and status API. The job id is a UUID, so the paths need no encoding.
 */
export function archiveSessionCookiePaths(jobId: string): string[] {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error('invalid archive job id');
  return [`/archive/${jobId}`, `/api/v1/public/archives/${jobId}`];
}

/**
 * The same gallery session cookie, also sent to one archive job's page and status API, so a
 * password-protected gallery's archive re-checks the session (and its `access_version`) on
 * every status read without widening the cookie to other galleries or archives.
 */
export function archiveSessionSetCookies(
  jobId: string,
  token: string,
  expiresAt: Date,
  secure: boolean,
): string[] {
  return sessionSetCookies(archiveSessionCookiePaths(jobId), token, expiresAt, secure);
}

function sessionSetCookies(
  paths: string[],
  token: string,
  expiresAt: Date,
  secure: boolean,
): string[] {
  if (!isWellFormedSessionToken(token)) throw new Error('invalid gallery session token');
  return paths.map((path) =>
    [
      `${GALLERY_SESSION_COOKIE}=${token}`,
      `Path=${path}`,
      `Expires=${expiresAt.toUTCString()}`,
      'HttpOnly',
      ...(secure ? ['Secure'] : []),
      'SameSite=Lax',
    ].join('; '),
  );
}
