import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { serverEnv } from '@/lib/env';
import { authFlowQuery, parseConfirmFlowParams, postSignInPath } from '@/lib/return-to';
import { withRoute } from '@/lib/route';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const EMAIL_OTP_TYPES: readonly EmailOtpType[] = ['email', 'magiclink', 'signup'];

/**
 * Magic-link landing (T05). Accepts either
 * - `token_hash` + `type` (custom email template; works in any browser, FR-A04), or
 * - `code` (Supabase's default PKCE link; works only in the browser that requested it).
 * On success the session cookies are set and the user continues to the validated `returnTo`
 * (or the claim step for a publish intent). Failures go back to `/auth` with an accessible error.
 * The token never appears in logs (route template only, no query string).
 */
export const GET = withRoute('GET /auth/confirm', async (request, { log }) => {
  const url = new URL(request.url);
  const flow = parseConfirmFlowParams(
    url.searchParams,
    new URL(serverEnv().NEXT_PUBLIC_APP_URL).origin,
  );
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  const code = url.searchParams.get('code');

  const supabase = await createSupabaseServerClient();
  let verified = false;
  if (supabase && tokenHash && type && EMAIL_OTP_TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    verified = !error;
    if (error) log.info('magic link rejected', { kind: 'token_hash', code: error.code });
  } else if (supabase && code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    verified = !error;
    if (error) log.info('magic link rejected', { kind: 'pkce', code: error.code });
  }

  const target = verified
    ? postSignInPath(flow)
    : `/auth?${authFlowQuery(flow)}&error=link_invalid`;
  const response = NextResponse.redirect(new URL(target, url.origin), 303);
  response.headers.set('Cache-Control', 'no-store');
  return response;
});
