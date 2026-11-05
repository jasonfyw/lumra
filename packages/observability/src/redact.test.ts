import { describe, expect, it } from 'vitest';
import {
  createRedactor,
  redact,
  redactString,
  REDACTED,
  REDACTED_EMAIL,
  REDACTED_JWT,
} from './redact';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiYXVkIjoibHVtcmEtbWVkaWEifQ.dGhpc2lzbm90YXJlYWxzaWduYXR1cmU';
const PRESIGNED =
  'https://acct.r2.cloudflarestorage.com/lumra-originals/originals/u1/g1/m1/source' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261105%2Fauto%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20261105T000000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host' +
  '&X-Amz-Signature=deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef';

describe('key-based redaction', () => {
  it.each([
    'token',
    'accessToken',
    'refresh_token',
    'secret',
    'clientSecret',
    'password',
    'passwordHash',
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'signature',
    'X-Amz-Signature',
    'apiKey',
    'api_key',
    'x-api-key',
    'privateKey',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'email',
    'userEmail',
    'credentials',
    'SENTRY_DSN',
    'GUEST_CAPABILITY_PEPPER',
  ])('redacts %s', (key) => {
    expect(redact({ [key]: 'sensitive-value' })).toEqual({ [key]: REDACTED });
  });

  it.each([
    'requestId',
    'traceId',
    'galleryId',
    'mediaId',
    'status',
    'durationMs',
    'zip',
    'description',
    'type',
  ])('keeps %s', (key) => {
    expect(redact({ [key]: 'value' })).toEqual({ [key]: 'value' });
  });

  it('keeps allow-listed keys such as dedupeKey', () => {
    expect(redact({ dedupeKey: 'media.uploaded:abc' })).toEqual({
      dedupeKey: 'media.uploaded:abc',
    });
  });

  it('leaves absent sensitive values visible as absent', () => {
    expect(redact({ token: null, password: undefined, secret: '' })).toEqual({
      token: null,
      password: undefined,
      secret: '',
    });
  });

  it('redacts nested objects and arrays', () => {
    expect(
      redact({ a: { b: [{ password: 'x' }, { headers: { authorization: 'Bearer abcdefgh' } }] } }),
    ).toEqual({
      a: { b: [{ password: REDACTED }, { headers: { authorization: REDACTED } }] },
    });
  });

  it('truncates IP-keyed values instead of logging them in full', () => {
    expect(
      redact({
        ip: '203.0.113.42',
        clientIp: '2001:db8:85a3:8d3:1319:8a2e:370:7348',
        'x-forwarded-for': '198.51.100.7, 10.0.0.1',
        ipAddress: 'not-an-ip',
      }),
    ).toEqual({
      ip: '203.0.113.0/24',
      clientIp: '2001:db8:85a3::/48',
      'x-forwarded-for': '198.51.100.0/24, 10.0.0.0/24',
      ipAddress: REDACTED,
    });
  });

  it('supports extra and replaced key words and allow keys', () => {
    const custom = createRedactor({ extraKeyWords: ['slug'], allowKeys: ['publicKey'] });
    expect(custom.redact({ slug: 'abc', publicKey: 'pk', apiKey: 'x' })).toEqual({
      slug: REDACTED,
      publicKey: 'pk',
      apiKey: REDACTED,
    });
    const only = createRedactor({ keyWords: ['foo'] });
    expect(only.redact({ foo: 1, token: 'abc' })).toEqual({ foo: REDACTED, token: 'abc' });
  });
});

describe('value-based redaction', () => {
  it('redacts JWT-like strings', () => {
    expect(redactString(`token is ${JWT} ok`)).toBe(`token is ${REDACTED_JWT} ok`);
  });

  it('redacts bearer credentials', () => {
    expect(redactString('Authorization: Bearer abc.def-ghi_123')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it('redacts presigned URL signing params', () => {
    const out = redactString(PRESIGNED);
    expect(out).not.toContain('deadbeef');
    expect(out).not.toContain('AKIAEXAMPLE');
    expect(out).toContain(`X-Amz-Signature=${REDACTED}`);
    expect(out).toContain(`X-Amz-Credential=${REDACTED}`);
    expect(out.startsWith('https://acct.r2.cloudflarestorage.com/lumra-originals/')).toBe(true);
  });

  it('redacts token-ish query params and auth callback codes', () => {
    expect(redactString('/auth/confirm?token_hash=abc123&type=email&next=/dashboard')).toBe(
      `/auth/confirm?token_hash=${REDACTED}&type=email&next=/dashboard`,
    );
    expect(redactString('/auth/callback?code=xyz789')).toBe(`/auth/callback?code=${REDACTED}`);
    expect(redactString('https://app.test/#access_token=abc&refresh_token=def')).toBe(
      `https://app.test/#access_token=${REDACTED}&refresh_token=${REDACTED}`,
    );
  });

  it('redacts URL userinfo (DSNs, database URLs)', () => {
    expect(redactString('postgresql://postgres:hunter2@db.internal:5432/postgres')).toBe(
      `postgresql://${REDACTED}@db.internal:5432/postgres`,
    );
    expect(redactString('https://abc123public@o1.ingest.sentry.io/42')).not.toContain(
      'abc123public',
    );
  });

  it('redacts provider secrets', () => {
    expect(redactString('key sk_live_51Habcdefghijklmnop')).toBe(`key ${REDACTED}`);
    expect(redactString('whsec_abcdefghijklmnopqrstu')).toBe(REDACTED);
  });

  it('redacts email addresses', () => {
    expect(redactString('invite sent to jane.doe+photos@example.co.uk')).toBe(
      `invite sent to ${REDACTED_EMAIL}`,
    );
  });

  it('truncates IPv4 to /24 and IPv6 to /48', () => {
    expect(redactString('from 192.168.1.254.')).toBe('from 192.168.1.0/24.');
    expect(redactString('client 2001:db8::1 connected')).toBe('client 2001:db8:0::/48 connected');
    expect(redactString('mapped ::ffff:203.0.113.9')).toBe('mapped 0:0:0::/48');
    expect(redactString('fe80::1ff:fe23:4567:890a')).toBe('fe80:0:0::/48');
  });

  it('does not mangle timestamps, versions, UUIDs or durations', () => {
    const s =
      '2026-11-05T12:34:56.789Z 12:34:56 v1.2.3 9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d next@16.4.3';
    expect(redactString(s)).toBe(s);
  });

  it('is idempotent', () => {
    const once = redactString(`${PRESIGNED} 203.0.113.1 2001:db8::1 a@b.io ${JWT}`);
    expect(redactString(once)).toBe(once);
  });

  it('caps very long strings', () => {
    const out = redactString('a'.repeat(5000));
    expect(out.length).toBeLessThan(2100);
    expect(out.endsWith('[truncated]')).toBe(true);
  });
});

describe('structure handling', () => {
  it('handles circular references, depth, bigint, dates, errors, maps and headers', () => {
    const circ: Record<string, unknown> = { name: 'x' };
    circ.self = circ;
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } };
    const err = Object.assign(new Error('failed for a@b.io'), {
      code: 'E_FAIL',
      query: 'SELECT secret',
    });
    const out = redact({
      circ,
      deep,
      big: 10n,
      when: new Date('2026-11-05T00:00:00Z'),
      err,
      map: new Map([['token', 't']]),
      headers: new Headers({ cookie: 'sid=abc', 'content-type': 'text/plain' }),
      fn: () => 1,
      nan: Number.NaN,
    }) as Record<string, unknown>;
    expect(out.circ).toEqual({ name: 'x', self: '[Circular]' });
    expect(JSON.stringify(out.deep)).toContain('[Truncated]');
    expect(out.big).toBe('10');
    expect(out.when).toBe('2026-11-05T00:00:00.000Z');
    expect(out.err).toEqual({
      name: 'Error',
      message: `failed for ${REDACTED_EMAIL}`,
      code: 'E_FAIL',
    });
    expect(out.map).toEqual({ token: REDACTED });
    expect(out.headers).toEqual({ cookie: REDACTED, 'content-type': 'text/plain' });
    expect(out.fn).toBeUndefined();
    expect(out.nan).toBe('NaN');
  });

  it('does not mark repeated (non-circular) references as circular', () => {
    const shared = { v: 1 };
    expect(redact({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it('caps long arrays', () => {
    const out = redact(Array.from({ length: 150 }, (_, i) => i)) as unknown[];
    expect(out).toHaveLength(101);
    expect(out[100]).toBe('[50 more]');
  });
});
