'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { serverEnv } from '@/lib/env';
import { ApiFailure } from '@/lib/api';
import { logger } from '@/lib/log';
import { clientIp, enforceRateLimit } from '@/lib/rate-limit';
import {
  authFlowQuery,
  parseAuthFlowParams,
  postSignInPath,
  type AuthFlowParams,
} from '@/lib/return-to';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  classifySupabaseRateLimit,
  clampRetryAfter,
  rateLimitMessage as formatRateLimit,
} from '@/lib/auth-rate-limit';

/**
 * Passwordless sign-in (T05, FR-A04): Supabase email OTP + magic link via `@supabase/ssr`.
 * Server actions keep the flow on our origin (Next.js checks the action's Origin) and let us
 * validate `returnTo` server-side. Supabase's error text is never shown verbatim.
 */
export interface AuthFormState {
  step: 'email' | 'code';
  email: string;
  error: string | null;
  notice: string | null;
  /** Epoch ms of the last successful send; drives the resend cooldown. */
  sentAt: number | null;
  /** Set when a send was rate limited: seconds until a new code may be requested. */
  retryAfterSeconds?: number | null;
}

const log = logger.child({ component: 'auth' });

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const codeSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/));

const NOT_CONFIGURED = 'Sign-in is not available right now. Please try again later.';

function flowFrom(formData: FormData): AuthFlowParams {
  return parseAuthFlowParams({
    returnTo: formData.get('returnTo')?.toString(),
    intent: formData.get('intent')?.toString(),
    galleryId: formData.get('galleryId')?.toString(),
  });
}

/**
 * App-level per-IP limits (FR-A05, `RATE_LIMITS.authOtp*`) on top of Supabase Auth's own.
 * Returns a user-facing message when limited. Fails open (logged) if the limiter itself is
 * unavailable, e.g. no DATABASE_URL locally: Supabase's limits still apply.
 */
async function rateLimitMessage(
  rule: 'authOtpSend' | 'authOtpVerify',
): Promise<{ message: string; retryAfterSeconds: number | null } | null> {
  const incoming = await headers();
  const forwarded = new Headers();
  for (const name of ['x-forwarded-for', 'x-real-ip']) {
    const value = incoming.get(name);
    if (value) forwarded.set(name, value);
  }
  const request = new Request(serverEnv().NEXT_PUBLIC_APP_URL, { headers: forwarded });
  try {
    // No bot challenge here: the form has no Turnstile widget (yet).
    await enforceRateLimit(
      request,
      rule,
      { kind: 'ip', ip: clientIp(forwarded) },
      {
        log,
        challenge: null,
      },
    );
    return null;
  } catch (error) {
    if (error instanceof ApiFailure && error.error.code === 'rate_limited') {
      if (rule === 'authOtpSend') {
        const details = error.error.details as { retryAfterSeconds?: number } | undefined;
        const retryAfterSeconds = clampRetryAfter(details?.retryAfterSeconds);
        return {
          message: formatRateLimit({ scope: 'hourly', retryAfterSeconds }),
          retryAfterSeconds,
        };
      }
      return {
        message: 'Too many attempts. Wait a few minutes, then try again.',
        retryAfterSeconds: null,
      };
    }
    log.warn('auth rate limiter unavailable', { rule, err: error });
    return null;
  }
}

function isRateLimited(error: { status?: number; code?: string }): boolean {
  return error.status === 429 || (error.code ?? '').startsWith('over_');
}

export async function sendOtpAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = emailSchema.safeParse(formData.get('email')?.toString() ?? '');
  if (!email.success) {
    return { ...previous, step: 'email', error: 'Enter a valid email address.', notice: null };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ...previous, error: NOT_CONFIGURED, notice: null };

  const limited = await rateLimitMessage('authOtpSend');
  if (limited) {
    return {
      ...previous,
      email: email.data,
      error: limited.message,
      notice: null,
      retryAfterSeconds: limited.retryAfterSeconds,
    };
  }

  const confirmUrl = new URL('/auth/confirm', serverEnv().NEXT_PUBLIC_APP_URL);
  confirmUrl.search = authFlowQuery(flowFrom(formData)).toString();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.data,
    options: { emailRedirectTo: confirmUrl.toString(), shouldCreateUser: true },
  });
  if (error) {
    const limit = classifySupabaseRateLimit(error);
    log.warn('otp send failed', {
      status: error.status,
      code: error.code,
      ...(limit && { limitScope: limit.scope, retryAfterSeconds: limit.retryAfterSeconds }),
    });
    return {
      ...previous,
      email: email.data,
      error: limit
        ? formatRateLimit(limit)
        : 'We couldn’t send the email. Check the address and try again.',
      notice: null,
      retryAfterSeconds: limit?.retryAfterSeconds ?? null,
    };
  }
  return {
    step: 'code',
    email: email.data,
    error: null,
    notice: `We sent a 6-digit code and a sign-in link to ${email.data}.`,
    sentAt: Date.now(),
    retryAfterSeconds: null,
  };
}

export async function verifyOtpAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = emailSchema.safeParse(formData.get('email')?.toString() ?? '');
  const code = codeSchema.safeParse(formData.get('code')?.toString() ?? '');
  if (!email.success) return { ...previous, step: 'email', error: 'Enter your email again.' };
  if (!code.success) {
    return { ...previous, error: 'Enter the 6-digit code from the email.', notice: null };
  }
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ...previous, error: NOT_CONFIGURED, notice: null };

  const limited = await rateLimitMessage('authOtpVerify');
  if (limited) return { ...previous, error: limited.message, notice: null };

  const { error } = await supabase.auth.verifyOtp({
    email: email.data,
    token: code.data,
    type: 'email',
  });
  if (error) {
    log.info('otp verify failed', { status: error.status, code: error.code });
    return {
      ...previous,
      error: isRateLimited(error)
        ? 'Too many attempts. Wait a minute, then try again.'
        : 'That code is incorrect or has expired. Check the latest email or send a new code.',
      notice: null,
    };
  }
  redirect(postSignInPath(flowFrom(formData)));
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (supabase) {
    const { error } = await supabase.auth.signOut();
    if (error) log.warn('sign out failed', { status: error.status, code: error.code });
  }
  redirect('/');
}
