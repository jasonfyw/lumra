import { MEDIA_TOKEN, type MediaTokenKeyring } from '@lumra/config';
import {
  mediaTokenClaimsSchema,
  mediaTokenHeaderSchema,
  type MediaTokenClaims,
  type MediaTokenHeader,
} from '@lumra/contracts';
import { decodeBase64Url, encodeBase64Url, encodeJsonBase64Url } from './base64url';

/**
 * Compact JWS (RFC 7515) with HMAC-SHA256, using WebCrypto only so the same code signs in
 * the Next.js server (Node 22) and verifies in the Cloudflare Worker gateway (ADR-001).
 *
 * Hardening:
 * - the header must be exactly `alg: HS256` with a known `kid` — `none`, RS256/ES256 and
 *   any other algorithm are rejected before the key is touched (no alg confusion);
 * - the signature is checked before claims are parsed, using a constant-time comparison;
 * - `exp` must be in the future and at most `MEDIA_TOKEN.maxTtlSeconds` ahead (plus skew),
 *   `iat` must not be in the future, and `jti` must be present.
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a minting endpoint supplies; `aud`, `iat` and `exp` are filled in by the signer. */
export type MediaTokenInput = DistributiveOmit<MediaTokenClaims, 'aud' | 'iat' | 'exp' | 'jti'> & {
  jti?: string;
};

export interface SignOptions {
  now?: Date;
  /** Defaults to and may not exceed `MEDIA_TOKEN.maxTtlSeconds`. */
  ttlSeconds?: number;
}

export interface VerifyOptions {
  now?: Date;
  audience?: string;
  clockSkewSeconds?: number;
}

export type VerifyFailure = 'expired' | 'bad_signature' | 'malformed' | 'wrong_audience';

export type VerifyResult =
  { status: 'ok'; claims: MediaTokenClaims; kid: string } | { status: VerifyFailure };

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function importHmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    // Bounded: a keyring holds a handful of keys; clear defensively if misused.
    if (keyCache.size > 16) keyCache.clear();
    keyCache.set(secret, key);
  }
  return key;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

/** Constant-time byte comparison (length is not secret: HS256 output is always 32 bytes). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

function randomJti(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

const toSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

export async function signMediaToken(
  input: MediaTokenInput,
  keyring: MediaTokenKeyring,
  options: SignOptions = {},
): Promise<string> {
  const ttl = options.ttlSeconds ?? MEDIA_TOKEN.maxTtlSeconds;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MEDIA_TOKEN.maxTtlSeconds) {
    throw new RangeError(`Media token TTL must be 1..${MEDIA_TOKEN.maxTtlSeconds} seconds`);
  }
  const secret = keyring.keys.get(keyring.activeKid);
  if (!secret) throw new Error('Active media-token key is missing from the keyring');

  const iat = toSeconds(options.now ?? new Date());
  // Validates the complete claim set so the signer can never mint a token the gateway rejects.
  const claims = mediaTokenClaimsSchema.parse({
    ...input,
    jti: input.jti ?? randomJti(),
    aud: MEDIA_TOKEN.audience,
    iat,
    exp: iat + ttl,
  });
  const header: MediaTokenHeader = { alg: 'HS256', typ: 'JWT', kid: keyring.activeKid };
  const signingInput = `${encodeJsonBase64Url(header)}.${encodeJsonBase64Url(claims)}`;
  return `${signingInput}.${encodeBase64Url(await hmac(secret, signingInput))}`;
}

function parseJsonSegment(segment: string): unknown {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return undefined;
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export async function verifyMediaToken(
  token: string,
  keyring: MediaTokenKeyring,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  if (typeof token !== 'string' || token.length > MEDIA_TOKEN.maxEncodedLength) {
    return { status: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { status: 'malformed' };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const rawHeader = parseJsonSegment(headerB64);
  const header = mediaTokenHeaderSchema.safeParse(rawHeader);
  // Anything but HS256 (incl. `none`, RS256) or extra semantics (`crit`) is refused outright.
  if (!header.success || (isRecord(rawHeader) && 'crit' in rawHeader)) {
    return { status: 'malformed' };
  }

  const signature = decodeBase64Url(signatureB64);
  if (!signature) return { status: 'malformed' };
  const secret = keyring.keys.get(header.data.kid);
  if (!secret) return { status: 'bad_signature' };
  const expected = await hmac(secret, `${headerB64}.${payloadB64}`);
  if (!timingSafeEqual(expected, signature)) return { status: 'bad_signature' };

  // Authentic from here on; classify claim problems.
  const payload = parseJsonSegment(payloadB64);
  if (!isRecord(payload)) return { status: 'malformed' };
  if (payload.aud !== (options.audience ?? MEDIA_TOKEN.audience)) {
    return { status: 'wrong_audience' };
  }
  const now = toSeconds(options.now ?? new Date());
  const skew = options.clockSkewSeconds ?? MEDIA_TOKEN.clockSkewSeconds;
  if (typeof payload.exp === 'number' && payload.exp + skew <= now) return { status: 'expired' };

  const claims = mediaTokenClaimsSchema.safeParse(payload);
  if (!claims.success) return { status: 'malformed' };
  const { iat, exp } = claims.data;
  if (exp - iat > MEDIA_TOKEN.maxTtlSeconds || exp <= iat) return { status: 'malformed' };
  if (exp - now > MEDIA_TOKEN.maxTtlSeconds + skew || iat > now + skew) {
    return { status: 'malformed' };
  }
  return { status: 'ok', claims: claims.data, kid: header.data.kid };
}
