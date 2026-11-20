/**
 * Minimal Resend REST client (`POST https://api.resend.com/emails`). No SDK: Workers-safe and
 * dependency-free. The API key and recipient address are never logged here.
 */
export const RESEND_API_URL = 'https://api.resend.com/emails';

export interface ResendEmail {
  from: string;
  to: string;
  replyTo?: string | undefined;
  subject: string;
  html: string;
  text: string;
}

export type ResendResult =
  | { kind: 'sent'; id: string | null }
  /** 429, 5xx, concurrent idempotent request or network error: let the queue retry. */
  | { kind: 'retry'; status: number | null; reason: string }
  /** Other 4xx (validation, bad key, domain): retrying cannot help. */
  | { kind: 'rejected'; status: number; reason: string };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function sendWithResend(
  email: ResendEmail,
  opts: { apiKey: string; idempotencyKey: string; fetch?: FetchLike; signal?: AbortSignal },
): Promise<ResendResult> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': opts.idempotencyKey,
      },
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch {
    return { kind: 'retry', status: null, reason: 'network_error' };
  }

  let body: { id?: unknown; name?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Non-JSON body (e.g. a gateway error page): the status alone decides.
  }
  const name = typeof body.name === 'string' ? body.name : 'unknown';

  if (response.ok) return { kind: 'sent', id: typeof body.id === 'string' ? body.id : null };
  if (response.status === 429 || response.status >= 500) {
    return { kind: 'retry', status: response.status, reason: name };
  }
  if (response.status === 409 && name === 'concurrent_idempotent_requests') {
    return { kind: 'retry', status: 409, reason: name };
  }
  return { kind: 'rejected', status: response.status, reason: name };
}
