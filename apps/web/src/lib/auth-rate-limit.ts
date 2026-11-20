/**
 * Maps rate-limit failures on the sign-in flow to a structured, user-facing result. Pure (no
 * server-only imports) so it is unit-testable and safe to share with the client form.
 */
export const OTP_ADDRESS_COOLDOWN_S = 60;
/** Fallback wait for Supabase's project-wide (hourly) email/OTP limits, which give no hint. */
export const OTP_PROJECT_LIMIT_WAIT_S = 15 * 60;
const MAX_RETRY_AFTER_S = 60 * 60;

export type RateLimitScope = 'address' | 'hourly';

export interface RateLimitInfo {
  scope: RateLimitScope;
  retryAfterSeconds: number;
}

/** Parses N from "...you can only request this after N seconds" (Supabase per-address limit). */
export function parseSupabaseRetrySeconds(message: string | undefined): number | null {
  const match = /after\s+(\d{1,5})\s*(?:second|sec|s\b)/i.exec(message ?? '');
  if (!match) return null;
  const seconds = Number(match[1]);
  return seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_S) : null;
}

export function clampRetryAfter(seconds: number | undefined): number {
  if (!seconds || !Number.isFinite(seconds)) return OTP_ADDRESS_COOLDOWN_S;
  return Math.min(Math.max(1, Math.ceil(seconds)), MAX_RETRY_AFTER_S);
}

/** Classifies a Supabase Auth error; null when it is not a rate limit. */
export function classifySupabaseRateLimit(error: {
  status?: number;
  code?: string;
  message?: string;
}): RateLimitInfo | null {
  const code = error.code ?? '';
  if (error.status !== 429 && !code.startsWith('over_')) return null;
  const parsed = parseSupabaseRetrySeconds(error.message);
  if (parsed) return { scope: 'address', retryAfterSeconds: parsed };
  // Project-wide limits ("email rate limit exceeded", OTP/request limits) carry no wait hint.
  if (code === 'over_email_send_rate_limit' && !/rate limit exceeded/i.test(error.message ?? '')) {
    return { scope: 'address', retryAfterSeconds: OTP_ADDRESS_COOLDOWN_S };
  }
  return { scope: 'hourly', retryAfterSeconds: OTP_PROJECT_LIMIT_WAIT_S };
}

export function rateLimitMessage(info: RateLimitInfo): string {
  const s = info.retryAfterSeconds;
  if (info.scope === 'address' && s <= 90) {
    return `You can request a new code in ${s}s.`;
  }
  const minutes = Math.max(1, Math.ceil(s / 60));
  return `Too many sign-in emails. Try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}
