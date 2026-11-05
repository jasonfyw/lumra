import { describe, expect, it } from 'vitest';
import {
  clientIp,
  decideRateLimit,
  hashRateSubject,
  rateLimitBucketKey,
  truncateIp,
} from './rate-limit-key';

const PEPPER = 'p'.repeat(40);

describe('clientIp', () => {
  it('prefers platform headers and takes the left-most forwarded entry', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe(
      '203.0.113.7',
    );
    expect(
      clientIp(new Headers({ 'x-real-ip': '198.51.100.2', 'x-forwarded-for': '203.0.113.7' })),
    ).toBe('198.51.100.2');
    expect(clientIp(new Headers({ 'x-vercel-forwarded-for': '192.0.2.1' }))).toBe('192.0.2.1');
    expect(clientIp(new Headers())).toBeNull();
  });
});

describe('truncateIp', () => {
  it('keeps full IPv4 by default and truncates IPv6 to /64', () => {
    expect(truncateIp('203.0.113.7')).toBe('v4:203.0.113.7');
    expect(truncateIp('2001:db8:abcd:12:1:2:3:4')).toBe('v6:2001:db8:abcd:12:0:0:0:0');
    expect(truncateIp('2001:db8:abcd:12::99')).toBe('v6:2001:db8:abcd:12:0:0:0:0');
    expect(truncateIp('[2001:DB8::1]')).toBe('v6:2001:db8:0:0:0:0:0:0');
  });

  it('treats IPv4-mapped IPv6 as IPv4', () => {
    expect(truncateIp('::ffff:203.0.113.7')).toBe('v4:203.0.113.7');
  });

  it('honours configurable prefixes', () => {
    expect(truncateIp('203.0.113.7', { ipv4PrefixBits: 24, ipv6PrefixBits: 48 })).toBe(
      'v4:203.0.113.0',
    );
    expect(truncateIp('2001:db8:abcd:12::1', { ipv4PrefixBits: 32, ipv6PrefixBits: 52 })).toBe(
      'v6:2001:db8:abcd:0:0:0:0:0',
    );
  });

  it('maps missing or malformed input to one shared bucket', () => {
    expect(truncateIp(null)).toBe('unknown');
    expect(truncateIp('999.1.1.1')).toBe('unknown');
    expect(truncateIp('not-an-ip')).toBe('unknown');
    expect(truncateIp('1::2::3')).toBe('unknown');
  });
});

describe('hashRateSubject', () => {
  it('is a peppered, truncated HMAC that never contains the raw IP or id', async () => {
    const hash = await hashRateSubject({ kind: 'ip', ip: '203.0.113.7' }, PEPPER);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).not.toContain('203');
    expect(await hashRateSubject({ kind: 'ip', ip: '203.0.113.7' }, PEPPER)).toBe(hash);
    expect(await hashRateSubject({ kind: 'ip', ip: '203.0.113.7' }, 'q'.repeat(40))).not.toBe(hash);
  });

  it('separates subject kinds and groups an IPv6 /64', async () => {
    const id = '6f1c1a5e-1d2b-4c3a-9e8f-0a1b2c3d4e5f';
    expect(await hashRateSubject({ kind: 'user', userId: id }, PEPPER)).not.toBe(
      await hashRateSubject({ kind: 'guest', guestSessionId: id }, PEPPER),
    );
    expect(await hashRateSubject({ kind: 'ip', ip: '2001:db8:1:2::1' }, PEPPER)).toBe(
      await hashRateSubject({ kind: 'ip', ip: '2001:db8:1:2:ffff::9' }, PEPPER),
    );
  });

  it('requires a pepper', async () => {
    await expect(hashRateSubject({ kind: 'ip', ip: null }, '')).rejects.toThrow();
  });

  it('builds `{rule}:{hash}` bucket keys and rejects odd rule names', async () => {
    const key = await rateLimitBucketKey(
      'guestDraftCreate',
      { kind: 'ip', ip: '192.0.2.1' },
      PEPPER,
    );
    expect(key).toMatch(/^guestDraftCreate:[0-9a-f]{32}$/);
    await expect(rateLimitBucketKey('a b', { kind: 'ip', ip: null }, PEPPER)).rejects.toThrow();
  });
});

describe('decideRateLimit (sliding window)', () => {
  const rule = { limit: 10, windowSeconds: 60, challengeAt: 5 };
  const windowStartedAt = new Date('2026-11-05T00:00:00Z');
  const at = (s: number) => new Date(windowStartedAt.getTime() + s * 1000);

  it('weights the previous window by its remaining overlap', () => {
    // 30 s into the window: half of the previous 10 still counts.
    expect(
      decideRateLimit(rule, { currentCount: 5, previousCount: 10, windowStartedAt, now: at(30) }),
    ).toEqual({ allowed: true, estimate: 10, challenge: true });
    expect(
      decideRateLimit(rule, { currentCount: 6, previousCount: 10, windowStartedAt, now: at(30) }),
    ).toEqual({ allowed: false, estimate: 11, retryAfterSeconds: 30 });
  });

  it('flags a challenge above challengeAt but below the limit', () => {
    expect(
      decideRateLimit(rule, { currentCount: 5, previousCount: 0, windowStartedAt, now: at(1) }),
    ).toMatchObject({ allowed: true, challenge: false });
    expect(
      decideRateLimit(rule, { currentCount: 6, previousCount: 0, windowStartedAt, now: at(1) }),
    ).toMatchObject({ allowed: true, challenge: true });
  });

  it('always returns a Retry-After of at least one second', () => {
    expect(
      decideRateLimit(rule, { currentCount: 11, previousCount: 0, windowStartedAt, now: at(60) }),
    ).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
  });
});
