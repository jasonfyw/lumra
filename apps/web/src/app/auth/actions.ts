'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { serverEnv } from '@/lib/env';
import { logger } from '@/lib/log';
import {
  authFlowQuery,
  parseAuthFlowParams,
  postSignInPath,
  type AuthFlowParams,
} from '@/lib/return-to';
import { createSupabaseServerClient } from '@/lib/supabase/server';

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

  // TODO(rate-limit): app-level per-IP/per-email send limit (FR-A05) via lib/rate-limit.ts once
  // T06 lands it. Until then Supabase Auth's built-in limits apply (email_sent, max_frequency).
  const confirmUrl = new URL('/auth/confirm', serverEnv().NEXT_PUBLIC_APP_URL);
  confirmUrl.search = authFlowQuery(flowFrom(formData)).toString();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.data,
    options: { emailRedirectTo: confirmUrl.toString(), shouldCreateUser: true },
  });
  if (error) {
    log.warn('otp send failed', { status: error.status, code: error.code });
    return {
      ...previous,
      email: email.data,
      error: isRateLimited(error)
        ? 'Too many sign-in emails. Wait a minute, then try again.'
        : 'We couldn’t send the email. Check the address and try again.',
      notice: null,
    };
  }
  return {
    step: 'code',
    email: email.data,
    error: null,
    notice: `We sent a 6-digit code and a sign-in link to ${email.data}.`,
    sentAt: Date.now(),
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

  // TODO(rate-limit): app-level verify-attempt limit (FR-A05); Supabase limits verifications.
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
