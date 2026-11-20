import { EMAIL_TEMPLATES, type EmailSendMessage } from '@lumra/contracts';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../log';
import { renderEmail, formatMicroUsd } from '../email/templates';
import { DEFAULT_EMAIL_FROM, EmailRetryError, handleEmailSend } from './email';

const ADDRESS = 'jane.doe@example.com';
const API_KEY = 're_test_supersecretkey123';
const accountId = '00000000-0000-4000-8000-000000000001';

function message(over: Partial<EmailSendMessage> = {}): EmailSendMessage {
  return {
    type: 'email.send',
    accountId,
    template: 'payment_failed',
    data: {},
    traceId: 't-1',
    dedupeKey: `email:payment_failed:${accountId}:2026-11-20T00:00:00.000Z`,
    ...over,
  };
}

function logger() {
  const calls: unknown[] = [];
  const record = (...args: unknown[]) => void calls.push(args);
  const log = {
    ...silentLogger,
    debug: record,
    info: record,
    warn: record,
    error: record,
  } as unknown as typeof silentLogger;
  return { log, calls };
}

const contacts = { emailFor: vi.fn(async () => ADDRESS as string | null) };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

describe('handleEmailSend', () => {
  it('posts to Resend with the dedupe key as Idempotency-Key and the default sender', async () => {
    const { log } = logger();
    const fetchMock = vi.fn(async () => json(200, { id: 'em_1' }));
    const outcome = await handleEmailSend(message(), {
      contacts,
      config: { apiKey: API_KEY },
      log,
      fetch: fetchMock,
    });
    expect(outcome).toBe('sent');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe(message().dedupeKey);
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ from: DEFAULT_EMAIL_FROM, to: [ADDRESS] });
    expect(body.reply_to).toBeUndefined();
    expect(body.subject).toMatch(/payment failed/);
    expect(body.html).toContain('https://www.lumra.photos/account');
    expect(body.text).toContain('https://www.lumra.photos/account');
  });

  it('honours custom from, reply-to and app url', async () => {
    const { log } = logger();
    const fetchMock = vi.fn(async () => json(200, { id: 'em_1' }));
    await handleEmailSend(message(), {
      contacts,
      config: {
        apiKey: API_KEY,
        from: 'Lumra <billing@lumra.photos>',
        replyTo: 'help@lumra.photos',
        appUrl: 'http://localhost:3000/',
      },
      log,
      fetch: fetchMock,
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body).toMatchObject({
      from: 'Lumra <billing@lumra.photos>',
      reply_to: 'help@lumra.photos',
    });
    expect(body.html).toContain('http://localhost:3000/account');
  });

  it.each([429, 500, 503])('throws a retryable error on %i', async (status) => {
    const { log } = logger();
    const fetchMock = vi.fn(async () => json(status, { name: 'rate_limit_exceeded' }));
    await expect(
      handleEmailSend(message(), { contacts, config: { apiKey: API_KEY }, log, fetch: fetchMock }),
    ).rejects.toBeInstanceOf(EmailRetryError);
  });

  it('retries on network errors', async () => {
    const { log } = logger();
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      handleEmailSend(message(), { contacts, config: { apiKey: API_KEY }, log, fetch: fetchMock }),
    ).rejects.toBeInstanceOf(EmailRetryError);
  });

  it('retries a concurrent idempotent request but not an invalid one', async () => {
    const { log } = logger();
    await expect(
      handleEmailSend(message(), {
        contacts,
        config: { apiKey: API_KEY },
        log,
        fetch: async () => json(409, { name: 'concurrent_idempotent_requests' }),
      }),
    ).rejects.toBeInstanceOf(EmailRetryError);
    await expect(
      handleEmailSend(message(), {
        contacts,
        config: { apiKey: API_KEY },
        log,
        fetch: async () => json(409, { name: 'invalid_idempotent_request' }),
      }),
    ).resolves.toBe('rejected');
  });

  it('acks a 4xx validation error as rejected (no retry)', async () => {
    const { log, calls } = logger();
    const outcome = await handleEmailSend(message(), {
      contacts,
      config: { apiKey: API_KEY },
      log,
      fetch: async () => json(422, { name: 'validation_error', message: `bad ${ADDRESS}` }),
    });
    expect(outcome).toBe('rejected');
    expect(JSON.stringify(calls)).toContain('validation_error');
  });

  it('logs and acks when RESEND_API_KEY is unset, without touching the DB or network', async () => {
    const { log, calls } = logger();
    const emailFor = vi.fn(async () => ADDRESS as string | null);
    const fetchMock = vi.fn();
    const outcome = await handleEmailSend(message(), {
      contacts: { emailFor },
      config: {},
      log,
      fetch: fetchMock,
    });
    expect(outcome).toBe('skipped_unconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailFor).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('acks when the account has no address', async () => {
    const { log } = logger();
    const fetchMock = vi.fn();
    const outcome = await handleEmailSend(message(), {
      contacts: { emailFor: async () => null },
      config: { apiKey: API_KEY },
      log,
      fetch: fetchMock,
    });
    expect(outcome).toBe('skipped_no_recipient');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never logs the address, the API key or the body', async () => {
    const { log, calls } = logger();
    for (const status of [200, 429, 422]) {
      await handleEmailSend(message(), {
        contacts,
        config: { apiKey: API_KEY },
        log,
        fetch: async () => json(status, { id: 'em_1', name: 'x', message: ADDRESS }),
      }).catch(() => {});
    }
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain(ADDRESS);
    expect(logged).not.toContain('jane');
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain('<html');
  });
});

describe('email templates', () => {
  const opts = { appUrl: 'https://www.lumra.photos' };

  it('renders every template as HTML and text with the account link', () => {
    for (const template of EMAIL_TEMPLATES) {
      const email = renderEmail(
        template,
        { thresholdPct: 80, spendMicroUsd: 8_000_000, capMicroUsd: 10_000_000 },
        opts,
      );
      expect(email.subject.length).toBeGreaterThan(5);
      expect(email.html).toContain('lumra<span');
      expect(email.html).toContain('max-width:560px');
      expect(email.html).toContain('href="https://www.lumra.photos/account"');
      expect(email.text).toContain('https://www.lumra.photos/account');
      expect(email.html).not.toContain('undefined');
      expect(email.text).not.toContain('undefined');
    }
  });

  it('matches snapshots of the subjects and plain text', () => {
    const rendered = Object.fromEntries(
      EMAIL_TEMPLATES.map((t) => {
        const e = renderEmail(
          t,
          { thresholdPct: 80, spendMicroUsd: 8_000_000, capMicroUsd: 10_000_000 },
          opts,
        );
        return [t, { subject: e.subject, text: e.text }];
      }),
    );
    expect(rendered).toMatchSnapshot();
  });

  it('formats spend-cap alerts at 50/80/100 percent', () => {
    const at = (pct: number) =>
      renderEmail(
        'spend_cap_alert',
        { thresholdPct: pct, spendMicroUsd: 5_000_000, capMicroUsd: 10_000_000 },
        opts,
      );
    expect(at(50).subject).toBe('Lumra usage alert: 50% of your spend cap');
    expect(at(50).text).toContain('$5.00 of your $10.00 cap');
    expect(at(80).subject).toContain('80%');
    expect(at(100).subject).toBe('You have reached your Lumra spend cap');
    expect(at(100).text).toContain('New uploads are paused');
  });

  it('formats micro-USD as dollars without floats', () => {
    expect(formatMicroUsd(0)).toBe('$0.00');
    expect(formatMicroUsd(10_000_000)).toBe('$10.00');
    expect(formatMicroUsd(1_234_560_000)).toBe('$1,234.56');
    expect(formatMicroUsd(5_000)).toBe('$0.01');
    expect(formatMicroUsd(4_999)).toBe('$0.00');
  });

  it('escapes untrusted values', () => {
    const email = renderEmail('payment_failed', {}, { appUrl: 'https://x.test/"><script>' });
    expect(email.html).not.toContain('<script>');
  });
});
