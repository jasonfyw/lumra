/**
 * Guest draft capability (FR-A01): a 256-bit random bearer secret in an HttpOnly cookie.
 * Only its HMAC (keyed by GUEST_CAPABILITY_PEPPER) is stored, so a database leak can't be
 * replayed as cookies. Web Crypto only, so this also runs in the proxy/edge.
 */
export const GUEST_COOKIE_NAME = 'lumra_guest';

const CAPABILITY_BYTES = 32;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateGuestCapability(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(CAPABILITY_BYTES)));
}

export function isWellFormedCapability(value: string | undefined): value is string {
  return typeof value === 'string' && CAPABILITY_PATTERN.test(value);
}

export async function hashGuestCapability(capability: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(capability));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function guestCookieOptions(expiresAt: Date, secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  };
}
