import type { EmailSendMessage } from '@lumra/contracts';
import type { AccountContactRepository } from '@lumra/db';
import { renderEmail } from '../email/templates';
import { sendWithResend, type FetchLike } from '../email/resend';
import type { Logger } from '../log';

export const DEFAULT_EMAIL_FROM = 'Lumra <noreply@lumra.photos>';
export const DEFAULT_APP_URL = 'https://www.lumra.photos';

export type EmailOutcome = 'sent' | 'skipped_unconfigured' | 'skipped_no_recipient' | 'rejected';

/** Thrown for transient Resend failures (429, 5xx, network): the queue redelivers with back-off. */
export class EmailRetryError extends Error {
  constructor(
    readonly status: number | null,
    readonly reason: string,
  ) {
    super(`email delivery deferred (status ${status ?? 'network'}, ${reason})`);
    this.name = 'EmailRetryError';
  }
}

export interface EmailConfig {
  apiKey?: string | undefined;
  from?: string | undefined;
  replyTo?: string | undefined;
  appUrl?: string | undefined;
}

export interface EmailSendDeps {
  contacts: Pick<AccountContactRepository, 'emailFor'>;
  config: EmailConfig;
  log: Logger;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * `email.send` (transition notices T33, spend-cap alerts T32). Renders the template, looks the
 * address up by account id at send time and posts to Resend with the outbox `dedupeKey` as the
 * `Idempotency-Key`, so a redelivered message never produces a second email.
 *
 * - No `RESEND_API_KEY`: logged and acked (the in-app banners still show the state).
 * - 429 / 5xx / network: throws `EmailRetryError` so the queue retries (max_retries, then DLQ).
 * - Other 4xx: logged as an error and acked; retrying cannot help.
 *
 * Logs carry the template, account id and Resend status only: never the address, the key or the
 * rendered body.
 */
export async function handleEmailSend(
  message: EmailSendMessage,
  deps: EmailSendDeps,
): Promise<EmailOutcome> {
  const { log, config } = deps;
  if (!config.apiKey) {
    log.info('email not sent: RESEND_API_KEY not set', {
      template: message.template,
      accountId: message.accountId,
    });
    return 'skipped_unconfigured';
  }

  const to = await deps.contacts.emailFor(message.accountId);
  if (!to) {
    log.warn('email not sent: account has no address', {
      template: message.template,
      accountId: message.accountId,
    });
    return 'skipped_no_recipient';
  }

  const appUrl = (config.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, '');
  const rendered = renderEmail(message.template, message.data, { appUrl });
  const result = await sendWithResend(
    {
      from: config.from ?? DEFAULT_EMAIL_FROM,
      to,
      replyTo: config.replyTo,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    },
    {
      apiKey: config.apiKey,
      idempotencyKey: message.dedupeKey,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
  );

  switch (result.kind) {
    case 'sent':
      log.info('email sent', {
        template: message.template,
        accountId: message.accountId,
        providerId: result.id,
      });
      return 'sent';
    case 'retry':
      log.warn('email delivery will be retried', {
        template: message.template,
        accountId: message.accountId,
        status: result.status,
        reason: result.reason,
      });
      throw new EmailRetryError(result.status, result.reason);
    case 'rejected':
      log.error('email rejected by provider; not retrying', {
        template: message.template,
        accountId: message.accountId,
        status: result.status,
        reason: result.reason,
      });
      return 'rejected';
  }
}
