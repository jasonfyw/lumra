import { describe, expect, it } from 'vitest';
import { serializeError } from './errors';
import { healthPayload } from './health';
import {
  generateRequestId,
  isValidRequestId,
  REQUEST_ID_HEADER,
  resolveRequestId,
  withTraceId,
} from './request-id';
import { scrubSentryBreadcrumb, scrubSentryEvent, sentryBaseOptions } from './sentry';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('request IDs', () => {
  it('accepts UUIDs and safe opaque IDs up to 64 chars', () => {
    expect(isValidRequestId('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d')).toBe(true);
    expect(isValidRequestId('iad1::abc12-1730764800000-0123456789ab')).toBe(true);
    expect(isValidRequestId('a'.repeat(64))).toBe(true);
  });

  it.each([
    '',
    'a'.repeat(65),
    'has space',
    'x\r\nSet-Cookie: a=b',
    '<script>',
    '-leading',
    'émoji',
  ])('rejects %j', (value) => {
    expect(isValidRequestId(value)).toBe(false);
  });

  it('generates v4 UUIDs', () => {
    expect(generateRequestId()).toMatch(UUID);
  });

  it('reuses a valid inbound header and replaces an invalid one', () => {
    expect(resolveRequestId(new Headers({ [REQUEST_ID_HEADER]: 'req-abc-123' }))).toBe(
      'req-abc-123',
    );
    expect(
      resolveRequestId(new Request('https://x.test', { headers: { 'X-Request-Id': 'req-2' } })),
    ).toBe('req-2');
    expect(resolveRequestId(new Headers({ [REQUEST_ID_HEADER]: 'bad id!' }))).toMatch(UUID);
    expect(resolveRequestId(new Headers())).toMatch(UUID);
    expect(resolveRequestId()).toMatch(UUID);
  });

  it('propagates the request ID into queue messages as traceId', () => {
    const msg = withTraceId({ type: 'media.uploaded', mediaId: 'm1', dedupeKey: 'd' }, 'req-7');
    expect(msg).toEqual({
      type: 'media.uploaded',
      mediaId: 'm1',
      dedupeKey: 'd',
      traceId: 'req-7',
    });
    expect(withTraceId({ type: 'x' }, 'not valid!').traceId).toMatch(UUID);
  });
});

describe('serializeError', () => {
  it('keeps only name, redacted message and primitive code', () => {
    const err = Object.assign(new TypeError('no access for a@b.io'), {
      code: 'P0001',
      detail: 'row data',
      config: { password: 'x' },
    });
    expect(serializeError(err)).toEqual({
      name: 'TypeError',
      message: 'no access for [REDACTED_EMAIL]',
      code: 'P0001',
    });
  });

  it('includes the stack only when asked', () => {
    expect(serializeError(new Error('x')).stack).toBeUndefined();
    expect(serializeError(new Error('x'), { includeStack: true }).stack).toContain('Error: x');
  });

  it('serializes bounded cause chains', () => {
    let err: Error = new Error('root');
    for (let i = 0; i < 6; i++) err = new Error(`level ${i}`, { cause: err });
    let depth = 0;
    for (let s = serializeError(err); s.cause; s = s.cause) depth++;
    expect(depth).toBe(3);
  });

  it('handles non-Error throwables and caps message length', () => {
    expect(serializeError('plain string')).toEqual({ name: 'NonError', message: 'plain string' });
    expect(serializeError({ message: 'obj' })).toEqual({ name: 'NonError', message: 'obj' });
    expect(serializeError(null)).toEqual({ name: 'NonError', message: 'thrown null' });
    expect(serializeError(42)).toEqual({ name: 'NonError', message: 'thrown number' });
    expect(serializeError(new Error('z'.repeat(2000))).message.length).toBeLessThanOrEqual(501);
  });

  it('sanitizes suspicious error names', () => {
    const err = new Error('x');
    err.name = 'Error <img src=x> with spaces';
    expect(serializeError(err).name).toBe('Error');
  });
});

describe('healthPayload', () => {
  it('returns status and service only by default', () => {
    expect(healthPayload('web')).toEqual({ status: 'ok', service: 'web' });
    expect(healthPayload('web', '')).toEqual({ status: 'ok', service: 'web' });
  });

  it('adds a short commit SHA when it looks like one', () => {
    expect(healthPayload('worker', 'ABCDEF0123456789abcdef0123456789abcdef01')).toEqual({
      status: 'ok',
      service: 'worker',
      commit: 'abcdef012345',
    });
    expect(healthPayload('worker', 'not-a-sha; rm -rf')).toEqual({
      status: 'ok',
      service: 'worker',
    });
  });
});

describe('sentry helpers', () => {
  it('disables the SDK without a DSN', () => {
    expect(sentryBaseOptions({})).toMatchObject({
      dsn: undefined,
      enabled: false,
      sendDefaultPii: false,
    });
    expect(sentryBaseOptions({ dsn: '  ' }).enabled).toBe(false);
    expect(
      sentryBaseOptions({ dsn: 'https://k@o1.ingest.sentry.io/1', release: 'abc' }),
    ).toMatchObject({
      enabled: true,
      release: 'abc',
    });
  });

  it('preserves SDK-internal metadata and event structure', () => {
    const meta = { request: { some: 'object' } };
    const event = {
      event_id: 'e1',
      level: 'error',
      tags: { requestId: 'req-1' },
      contexts: { trace: { trace_id: 't', span_id: 's' } },
      sdkProcessingMetadata: meta,
    };
    const out = scrubSentryEvent(event);
    expect(out.sdkProcessingMetadata).toBe(meta);
    expect(out.tags).toEqual({ requestId: 'req-1' });
    expect(out.contexts).toEqual(event.contexts);
  });

  it('passes through non-object events', () => {
    expect(scrubSentryEvent(null)).toBeNull();
  });

  it('scrubs breadcrumbs', () => {
    expect(
      scrubSentryBreadcrumb({
        category: 'fetch',
        data: { url: 'https://r2.test/k?X-Amz-Signature=abc&x=1' },
      }),
    ).toEqual({
      category: 'fetch',
      data: { url: 'https://r2.test/k?X-Amz-Signature=[REDACTED]&x=1' },
    });
  });
});
