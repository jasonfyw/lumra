/** Base64url without padding (RFC 7515 §2), Web APIs only so it runs in Workers and Node. */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns null for anything that is not canonical unpadded base64url. */
export function decodeBase64Url(input: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(input) || input.length % 4 === 1) return null;
  const padded =
    input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // Reject non-canonical encodings (non-zero trailing bits) so one token has one spelling.
  if (encodeBase64Url(bytes) !== input) return null;
  return bytes;
}

export function encodeJsonBase64Url(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}
