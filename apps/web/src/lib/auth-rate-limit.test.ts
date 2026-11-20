import { describe, expect, it } from 'vitest';
import {
  classifySupabaseRateLimit,
  clampRetryAfter,
  parseSupabaseRetrySeconds,
  rateLimitMessage,
} from './auth-rate-limit';

describe('parseSupabaseRetrySeconds', () => {
  it('parses the per-address message', () => {
    expect(
      parseSupabaseRetrySeconds(
        'For security purposes, you can only request this after 45 seconds.',
      ),
    ).toBe(45);
    expect(parseSupabaseRetrySeconds('you can only request this after 1 second')).toBe(1);
  });
  it('returns null otherwise', () => {
    expect(parseSupabaseRetrySeconds('email rate limit exceeded')).toBeNull();
    expect(parseSupabaseRetrySeconds(undefined)).toBeNull();
  });
});

describe('classifySupabaseRateLimit', () => {
  it('uses the parsed seconds for the per-address limit', () => {
    expect(
      classifySupabaseRateLimit({
        status: 429,
        code: 'over_email_send_rate_limit',
        message: 'For security purposes, you can only request this after 45 seconds.',
      }),
    ).toEqual({ scope: 'address', retryAfterSeconds: 45 });
  });
  it('defaults to 60 s for over_email_send_rate_limit without a number', () => {
    expect(
      classifySupabaseRateLimit({ status: 429, code: 'over_email_send_rate_limit', message: '' }),
    ).toEqual({ scope: 'address', retryAfterSeconds: 60 });
  });
  it('treats project-wide limits as hourly', () => {
    expect(
      classifySupabaseRateLimit({
        status: 429,
        code: 'over_email_send_rate_limit',
        message: 'email rate limit exceeded',
      })?.scope,
    ).toBe('hourly');
    expect(classifySupabaseRateLimit({ status: 429, code: 'over_request_rate_limit' })?.scope).toBe(
      'hourly',
    );
  });
  it('ignores other errors', () => {
    expect(classifySupabaseRateLimit({ status: 400, code: 'validation_failed' })).toBeNull();
  });
});

describe('messages and clamping', () => {
  it('formats both kinds', () => {
    expect(rateLimitMessage({ scope: 'address', retryAfterSeconds: 45 })).toBe(
      'You can request a new code in 45s.',
    );
    expect(rateLimitMessage({ scope: 'hourly', retryAfterSeconds: 1500 })).toBe(
      'Too many sign-in emails. Try again in about 25 minutes.',
    );
  });
  it('clamps Lumra limiter values', () => {
    expect(clampRetryAfter(undefined)).toBe(60);
    expect(clampRetryAfter(1234.2)).toBe(1235);
    expect(clampRetryAfter(99999)).toBe(3600);
  });
});
