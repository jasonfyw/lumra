/**
 * Pure helpers for the rate limiter (FR-A05): client IP extraction/truncation, peppered subject
 * hashing and the sliding-window estimate. Web APIs only, so they run anywhere and unit-test
 * without a database. Raw IPs and ids never leave this module unhashed.
 */
import { RATE_LIMIT_KEYS, type RateLimitRule } from '@lumra/config';

export type RateLimitSubject =
  | { kind: 'ip'; ip: string | null }
  | { kind: 'user'; userId: string }
  | { kind: 'guest'; guestSessionId: string };

/**
 * Client IP as set by the platform. On Vercel `x-forwarded-for`/`x-real-ip` are overwritten by
 * the edge, so the left-most `x-forwarded-for` entry is the client. Returns null when absent.
 */
export function clientIp(headers: Headers): string | null {
  const candidates = [
    headers.get('x-vercel-forwarded-for')?.split(',')[0],
    headers.get('x-real-ip'),
    headers.get('x-forwarded-for')?.split(',')[0],
  ];
  for (const raw of candidates) {
    const value = raw?.trim();
    if (value) return value;
  }
  return null;
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? bytes : null;
}

/** Expands an IPv6 address into 8 hextets, or null when malformed. Zone ids are dropped. */
function parseIpv6(input: string): number[] | null {
  let ip = input
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!
    .toLowerCase();
  const lastColon = ip.lastIndexOf(':');
  if (lastColon === -1) return null;
  if (ip.includes('.')) {
    // Embedded IPv4 (e.g. ::ffff:192.0.2.1): rewrite the dotted tail as two hextets.
    const v4 = parseIpv4(ip.slice(lastColon + 1));
    if (!v4) return null;
    const hex = (a: number, b: number) => ((a << 8) | b).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hex(v4[0]!, v4[1]!)}:${hex(v4[2]!, v4[3]!)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':'));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (![...head, ...rest].every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;
  const known = head.length + rest.length;
  if (halves.length === 1 && known !== 8) return null;
  if (halves.length === 2 && known > 7) return null;
  const zeros = halves.length === 2 ? Array<number>(8 - known).fill(0) : [];
  return [...head.map((h) => parseInt(h, 16)), ...zeros, ...rest.map((h) => parseInt(h, 16))];
}

function maskBits(units: number[], unitBits: number, keepBits: number): number[] {
  return units.map((unit, i) => {
    const start = i * unitBits;
    if (keepBits >= start + unitBits) return unit;
    if (keepBits <= start) return 0;
    const keep = keepBits - start;
    return unit & (((1 << keep) - 1) << (unitBits - keep));
  });
}

/**
 * Normalises and truncates an IP to its configured prefix (IPv4 /32, IPv6 /64 by default), so
 * IPv6 clients rotating addresses inside their /64 share one bucket. IPv4-mapped IPv6 is treated
 * as IPv4. Anything unparseable maps to the single `unknown` bucket.
 */
export function truncateIp(
  ip: string | null,
  prefixes: { ipv4PrefixBits: number; ipv6PrefixBits: number } = RATE_LIMIT_KEYS,
): string {
  if (!ip) return 'unknown';
  const v4 = parseIpv4(ip.trim());
  if (v4) return 'v4:' + maskBits(v4, 8, prefixes.ipv4PrefixBits).join('.');
  const v6 = parseIpv6(ip.trim());
  if (!v6) return 'unknown';
  if (v6.slice(0, 5).every((h) => h === 0) && v6[5] === 0xffff) {
    const mapped = [v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff];
    return 'v4:' + maskBits(mapped, 8, prefixes.ipv4PrefixBits).join('.');
  }
  return (
    'v6:' +
    maskBits(v6, 16, prefixes.ipv6PrefixBits)
      .map((h) => h.toString(16))
      .join(':')
  );
}

export function subjectString(subject: RateLimitSubject): string {
  switch (subject.kind) {
    case 'ip':
      return `ip|${truncateIp(subject.ip)}`;
    case 'user':
      return `user|${subject.userId}`;
    case 'guest':
      return `guest|${subject.guestSessionId}`;
  }
}

async function hmacHex(pepper: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Peppered, truncated HMAC of a subject (domain-separated from other uses of the pepper).
 * Also stored as `guest_sessions.rate_key_hash` for abuse correlation without raw IPs.
 */
export async function hashRateSubject(
  subject: RateLimitSubject,
  pepper: string,
  hexChars: number = RATE_LIMIT_KEYS.hashHexChars,
): Promise<string> {
  if (!pepper) throw new Error('rate limit pepper is required');
  const mac = await hmacHex(pepper, `lumra-rate-limit-v1|${subjectString(subject)}`);
  return mac.slice(0, hexChars);
}

/** Bucket key stored in `rate_limit_buckets.bucket_key`: `{rule}:{hash}`. */
export async function rateLimitBucketKey(
  ruleName: string,
  subject: RateLimitSubject,
  pepper: string,
): Promise<string> {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(ruleName)) throw new Error('invalid rate limit rule name');
  return `${ruleName}:${await hashRateSubject(subject, pepper)}`;
}

export interface WindowCounts {
  currentCount: number;
  previousCount: number;
  windowStartedAt: Date;
  now: Date;
}

export type RateLimitDecision =
  | { allowed: true; estimate: number; challenge: boolean }
  | { allowed: false; estimate: number; retryAfterSeconds: number };

/**
 * Sliding-window counter: the previous fixed window is weighted by how much of it still overlaps
 * the sliding window. `challenge` is set once the estimate passes `rule.challengeAt`.
 */
export function decideRateLimit(rule: RateLimitRule, counts: WindowCounts): RateLimitDecision {
  const windowMs = rule.windowSeconds * 1000;
  const elapsedMs = Math.min(
    windowMs,
    Math.max(0, counts.now.getTime() - counts.windowStartedAt.getTime()),
  );
  const previousWeight = (windowMs - elapsedMs) / windowMs;
  const estimate = counts.currentCount + Math.floor(counts.previousCount * previousWeight);
  if (estimate > rule.limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - elapsedMs) / 1000));
    return { allowed: false, estimate, retryAfterSeconds };
  }
  const challenge = rule.challengeAt !== undefined && estimate > rule.challengeAt;
  return { allowed: true, estimate, challenge };
}
