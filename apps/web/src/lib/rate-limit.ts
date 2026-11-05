import 'server-only';
import { sql } from 'drizzle-orm';
import { RATE_LIMITS, type RateLimitRule, type RateLimitRuleName } from '@lumra/config';
import type { Database } from '@lumra/db';
import type { Logger } from '@lumra/observability';
import { ApiFailure } from './api';
import { getDb } from './db';
import { ConfigurationError, serverEnv } from './env';
import {
  clientIp,
  decideRateLimit,
  hashRateSubject,
  rateLimitBucketKey,
  type RateLimitDecision,
  type RateLimitSubject,
} from './rate-limit-key';

export type { RateLimitSubject } from './rate-limit-key';
export { clientIp } from './rate-limit-key';

/** Fraction of limiter calls that also prune expired buckets (cheap: indexed, batched). */
const PRUNE_PROBABILITY = 0.02;
export const TURNSTILE_TOKEN_HEADER = 'x-turnstile-token';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Pepper for limiter keys; a dedicated one if set, else the guest pepper (domain-separated). */
export function rateLimitPepper(): string {
  const env = serverEnv();
  const pepper = env.RATE_LIMIT_PEPPER || env.GUEST_CAPABILITY_PEPPER;
  if (!pepper) throw new ConfigurationError('RATE_LIMIT_PEPPER');
  return pepper;
}

/** Peppered hash of the request's truncated client IP (stored as `guest_sessions.rate_key_hash`). */
export async function hashClientIp(request: Request): Promise<string> {
  return hashRateSubject({ kind: 'ip', ip: clientIp(request.headers) }, rateLimitPepper());
}

/** Counts one hit for `subject` under `rule` and returns the sliding-window decision. */
export async function checkRateLimit(
  db: Database,
  ruleName: string,
  rule: RateLimitRule,
  subject: RateLimitSubject,
  pepper: string,
): Promise<RateLimitDecision> {
  const key = await rateLimitBucketKey(ruleName, subject, pepper);
  const rows = await db.execute<{
    current_count: number;
    previous_count: number;
    window_started_at: Date | string;
    now_at: Date | string;
  }>(sql`select * from public.rate_limit_hit(${key}, ${rule.windowSeconds}::integer)`);
  const row = rows[0];
  if (!row) throw new Error('rate_limit_hit returned no row');
  if (Math.random() < PRUNE_PROBABILITY) {
    await db.execute(sql`select public.prune_rate_limit_buckets(500)`).catch(() => undefined);
  }
  return decideRateLimit(rule, {
    currentCount: Number(row.current_count),
    previousCount: Number(row.previous_count),
    windowStartedAt: new Date(row.window_started_at),
    now: new Date(row.now_at),
  });
}

export interface BotChallengeVerifier {
  (token: string, remoteIp: string | null): Promise<boolean>;
}

/**
 * Cloudflare Turnstile server-side verification. The client IP is passed to Cloudflare (the
 * provider needs it) but never stored or logged here.
 */
export function turnstileVerifier(secret: string, fetchImpl: typeof fetch = fetch) {
  return async (token: string, remoteIp: string | null): Promise<boolean> => {
    if (!token || token.length > 2048) return false;
    const form = new URLSearchParams({ secret, response: token });
    if (remoteIp) form.set('remoteip', remoteIp);
    try {
      const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: 'POST', body: form });
      if (!res.ok) return false;
      const body = (await res.json()) as { success?: unknown };
      return body.success === true;
    } catch {
      return false;
    }
  };
}

/** The configured bot-challenge hook, or null when `TURNSTILE_SECRET_KEY` is not set. */
export function configuredBotChallenge(): BotChallengeVerifier | null {
  const secret = serverEnv().TURNSTILE_SECRET_KEY;
  return secret ? turnstileVerifier(secret) : null;
}

export interface EnforceOptions {
  db?: Database;
  log?: Logger;
  /** Override the configured rule (tests, special routes). */
  rule?: RateLimitRule;
  /** Override the bot-challenge hook; `null` disables it. Defaults to `configuredBotChallenge()`. */
  challenge?: BotChallengeVerifier | null;
}

/**
 * Applies a named rule from `RATE_LIMITS` to `subject`. Throws an `ApiFailure`:
 * - 429 `rate_limited` with `Retry-After` once the sliding-window estimate exceeds the limit;
 * - 429 `rate_limited` with `details.challenge = 'turnstile'` above `challengeAt` when Turnstile
 *   is configured and the request lacks a valid `x-turnstile-token`.
 */
export async function enforceRateLimit(
  request: Request,
  ruleName: RateLimitRuleName,
  subject: RateLimitSubject,
  options: EnforceOptions = {},
): Promise<void> {
  const rule = options.rule ?? RATE_LIMITS[ruleName];
  const decision = await checkRateLimit(
    options.db ?? getDb(),
    ruleName,
    rule,
    subject,
    rateLimitPepper(),
  );
  if (!decision.allowed) {
    options.log?.warn('rate limited', { rule: ruleName, subject: subject.kind });
    throw new ApiFailure(
      {
        code: 'rate_limited',
        message: 'Too many requests. Please wait and try again.',
        retryable: true,
        details: { retryAfterSeconds: decision.retryAfterSeconds },
      },
      { 'Retry-After': String(decision.retryAfterSeconds) },
    );
  }
  if (!decision.challenge) return;
  const verify = options.challenge === undefined ? configuredBotChallenge() : options.challenge;
  if (!verify) return;
  const token = request.headers.get(TURNSTILE_TOKEN_HEADER) ?? '';
  if (await verify(token, clientIp(request.headers))) return;
  options.log?.info('bot challenge required', { rule: ruleName, subject: subject.kind });
  throw new ApiFailure({
    code: 'rate_limited',
    message: 'Please complete the verification challenge and try again.',
    retryable: true,
    details: { challenge: 'turnstile' },
  });
}
