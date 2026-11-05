import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';
import { scrubSentryEvent } from './sentry';

/**
 * T04 acceptance: "logs contain no secrets in a redaction unit test". Every secret below is
 * pushed through the logger (as fields, nested data, free text, error messages and causes)
 * and through the Sentry scrubber; none may appear verbatim in the output.
 */
const SECRETS = {
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLWJ5dGVz',
  password: 'correct-horse-battery-staple',
  stripeKey: 'sk_live_51HxYzAbCdEfGhIjKlMnOp',
  webhookSecret: 'whsec_9f8e7d6c5b4a39281706',
  amzSignature: '5d41402abc4b2a76b9719d911017c592aa5d41402abc4b2a76b9719d911017c5',
  amzCredential: 'AKIAIOSFODNN7EXAMPLE',
  email: 'photographer@studio.example',
  ipv4: '203.0.113.77',
  ipv6: '2001:db8:abcd:12:3456:789a:bcde:f012',
  cookie: 'lumra_guest=4f9c2a0d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f',
  dbPassword: 'pg-super-secret-pw',
  authCode: 'oauthcode123456',
};

const presignedUrl =
  `https://acct.r2.cloudflarestorage.com/lumra-originals/originals/u/g/m/source?X-Amz-Algorithm=AWS4-HMAC-SHA256` +
  `&X-Amz-Credential=${SECRETS.amzCredential}%2F20261105%2Fauto%2Fs3%2Faws4_request&X-Amz-Expires=900` +
  `&X-Amz-Signature=${SECRETS.amzSignature}`;

function assertNoSecrets(output: string) {
  for (const [name, secret] of Object.entries(SECRETS)) {
    expect(output, `leaked ${name}`).not.toContain(secret);
  }
  // No full IPv4 / IPv6 address survives, only network prefixes.
  expect(output).not.toMatch(/203\.0\.113\.77/);
}

describe('no secrets leak', () => {
  it('through the logger', () => {
    const lines: string[] = [];
    const log = createLogger({ service: 'leak-test', level: 'debug', sink: (l) => lines.push(l) });
    const reqLog = log.child({ requestId: 'req-1', authorization: `Bearer ${SECRETS.jwt}` });

    reqLog.info(`user ${SECRETS.email} from ${SECRETS.ipv4} opened ${presignedUrl}`, {
      headers: {
        authorization: `Bearer ${SECRETS.jwt}`,
        cookie: SECRETS.cookie,
        'x-forwarded-for': `${SECRETS.ipv4}, ${SECRETS.ipv6}`,
        'user-agent': 'Mozilla/5.0',
      },
      body: { email: SECRETS.email, password: SECRETS.password, nested: [{ token: SECRETS.jwt }] },
      config: {
        STRIPE_SECRET_KEY: SECRETS.stripeKey,
        STRIPE_WEBHOOK_SECRET: SECRETS.webhookSecret,
        DATABASE_URL: `postgresql://postgres:${SECRETS.dbPassword}@db:5432/postgres`,
      },
      url: `https://lumra.test/auth/callback?code=${SECRETS.authCode}`,
      note: `stripe said ${SECRETS.stripeKey} and ${SECRETS.webhookSecret}`,
      remote: SECRETS.ipv6,
    });

    const cause = new Error(`db auth failed for postgres://u:${SECRETS.dbPassword}@db/x`);
    reqLog.error('job failed', {
      err: new Error(`upload to ${presignedUrl} failed for ${SECRETS.email}`, { cause }),
    });

    const output = lines.join('\n');
    expect(lines).toHaveLength(2);
    expect(output).toContain('req-1');
    expect(output).toContain('203.0.113.0/24');
    assertNoSecrets(output);
  });

  it('through the Sentry scrubber', () => {
    const event = {
      event_id: 'abc',
      message: `failed for ${SECRETS.email}`,
      user: { id: 'user-1', email: SECRETS.email, ip_address: SECRETS.ipv4 },
      request: {
        url: presignedUrl,
        query_string: `code=${SECRETS.authCode}&next=/x`,
        cookies: { lumra_guest: SECRETS.cookie },
        headers: { Authorization: `Bearer ${SECRETS.jwt}`, 'X-Real-IP': SECRETS.ipv4 },
        data: { password: SECRETS.password },
      },
      exception: {
        values: [
          {
            type: 'Error',
            value: `Stripe error for key ${SECRETS.stripeKey}`,
            stacktrace: {
              frames: [{ filename: 'app.js', vars: { secret: SECRETS.webhookSecret } }],
            },
          },
        ],
      },
      breadcrumbs: [{ category: 'fetch', data: { url: presignedUrl } }],
      extra: { DATABASE_URL: `postgres://u:${SECRETS.dbPassword}@db/x` },
    };
    const scrubbed = scrubSentryEvent(event);
    const output = JSON.stringify(scrubbed);
    assertNoSecrets(output);
    expect(scrubbed.user).toEqual({ id: 'user-1' });
    expect(scrubbed.request.query_string).toBe('code=[REDACTED]&next=/x');
    expect(scrubbed.event_id).toBe('abc');
  });
});
