import 'server-only';
import { ApiFailure } from './api';
import { serverEnv } from './env';

/**
 * Anti-CSRF for state-changing endpoints (PRD §6.2), on top of SameSite=Lax cookies: when the
 * browser sends an `Origin` header it must be the app's own origin (or the request's origin, for
 * preview deployments served on their own host). Non-browser clients send no `Origin`.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin) return;
  const allowed = new Set<string>([new URL(request.url).origin]);
  try {
    allowed.add(new URL(serverEnv().NEXT_PUBLIC_APP_URL).origin);
  } catch {
    // unparsable env is caught at boot; fall back to the request origin only
  }
  if (allowed.has(origin)) return;
  throw new ApiFailure({
    code: 'forbidden',
    message: 'Cross-origin request rejected.',
    retryable: false,
  });
}
