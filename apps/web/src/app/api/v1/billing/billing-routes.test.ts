import Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DB-free authorization and configuration tests for the billing endpoints (T29). Supabase, the
 * DB and the webhook processor are stubbed; DB-backed behaviour lives in apps/web/test-db.
 */
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  handled: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({
  captureException: () => {},
  withScope: (fn: (scope: { setTag: () => void }) => void) => fn({ setTag: () => {} }),
}));
vi.mock('@/lib/supabase/server', () => ({
  isSupabaseConfigured: () => true,
  createSupabaseServerClient: async () => ({
    auth: {
      getUser: async () =>
        state.user
          ? { data: { user: state.user }, error: null }
          : { data: { user: null }, error: { status: 400 } },
    },
  }),
}));
vi.mock('@/lib/rate-limit', () => ({ enforceRateLimit: vi.fn(async () => {}) }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ fake: 'db' }) }));
vi.mock('@/server/billing-webhook', () => ({
  handleStripeEvent: vi.fn(async (_db: unknown, event: { id: string }) => {
    state.handled.push(event.id);
    return { outcome: 'processed', accountId: null, reevaluate: false };
  }),
  recordFailedEvent: vi.fn(async () => {}),
}));
vi.mock('@/server/billing-checkout', () => ({
  createCheckoutSession: vi.fn(async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test' })),
  createPortalSession: vi.fn(async () => ({ url: 'https://billing.stripe.com/p/session/test' })),
}));

const { resetServerEnvForTests } = await import('@/lib/env');
const { setStripeForTests } = await import('@/server/stripe');
const { POST: checkout } = await import('./checkout/route');
const { POST: portal } = await import('./portal/route');
const { POST: webhook } = await import('./webhook/route');

const SECRET = 'whsec_testsecret0123456789';
const KEY = 'sk_test_51abcdefghijklmnopqrstuvwxyz';

function configure(stripe: boolean) {
  process.env.NEXT_PUBLIC_APP_URL = 'https://lumra.test';
  if (stripe) {
    process.env.STRIPE_SECRET_KEY = KEY;
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  } else {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
  resetServerEnvForTests();
  setStripeForTests(undefined);
}

const post = (path: string, init: { origin?: string; body?: string } = {}) =>
  new Request(`https://lumra.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(init.origin ? { origin: init.origin } : {}),
    },
    body: init.body ?? '{}',
  });

beforeEach(() => {
  state.user = null;
  state.handled = [];
  configure(true);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe.each([
  ['checkout', checkout, '/api/v1/billing/checkout'],
  ['portal', portal, '/api/v1/billing/portal'],
] as const)('POST /api/v1/billing/%s', (_name, handler, path) => {
  it('401 without a signed-in user', async () => {
    const res = await handler(post(path), {});
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });

  it('403 for a cross-origin request, even when signed in', async () => {
    state.user = { id: '6f1c1a5e-1d2b-4c3a-9e8f-0a1b2c3d4e5f', email: 'a@example.test' };
    const res = await handler(post(path, { origin: 'https://evil.example' }), {});
    expect(res.status).toBe(403);
  });

  it('422 for an unexpected body', async () => {
    state.user = { id: '6f1c1a5e-1d2b-4c3a-9e8f-0a1b2c3d4e5f', email: 'a@example.test' };
    const res = await handler(post(path, { body: '{"price":"price_evil"}' }), {});
    expect(res.status).toBe(422);
  });

  it('503 billing_unavailable when Stripe is not configured (graceful)', async () => {
    configure(false);
    state.user = { id: '6f1c1a5e-1d2b-4c3a-9e8f-0a1b2c3d4e5f', email: 'a@example.test' };
    const res = await handler(post(path), {});
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('billing_unavailable');
  });

  it('returns the hosted Stripe URL for the signed-in owner', async () => {
    state.user = { id: '6f1c1a5e-1d2b-4c3a-9e8f-0a1b2c3d4e5f', email: 'a@example.test' };
    const res = await handler(post(path, { origin: 'https://lumra.test' }), {});
    expect(res.status).toBe(200);
    expect((await res.json()).data.url).toMatch(/^https:\/\/(checkout|billing)\.stripe\.com\//);
  });
});

describe('POST /api/v1/billing/webhook', () => {
  const event = {
    id: 'evt_test_1',
    object: 'event',
    type: 'customer.subscription.updated',
    created: 1_763_000_000,
    data: { object: { id: 'sub_1', object: 'subscription' } },
  };
  const payload = JSON.stringify(event);
  const signed = (body: string, secret = SECRET) =>
    new Request('https://lumra.test/api/v1/billing/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload: body, secret }),
      },
      body,
    });

  it('503 while billing is not configured, so Stripe retries later', async () => {
    configure(false);
    const res = await webhook(signed(payload), {});
    expect(res.status).toBe(503);
    expect(state.handled).toEqual([]);
  });

  it('rejects a missing or invalid signature without processing anything', async () => {
    const unsigned = new Request('https://lumra.test/api/v1/billing/webhook', {
      method: 'POST',
      body: payload,
    });
    expect((await webhook(unsigned, {})).status).toBe(422);
    expect((await webhook(signed(payload, 'whsec_wrongsecret0000000000'), {})).status).toBe(422);
    // Signature over different bytes (re-serialised JSON) must fail: raw body only.
    const tampered = signed(payload);
    const reordered = new Request(tampered.url, {
      method: 'POST',
      headers: tampered.headers,
      body: JSON.stringify({ ...event, type: 'customer.subscription.deleted' }),
    });
    expect((await webhook(reordered, {})).status).toBe(422);
    expect(state.handled).toEqual([]);
  });

  it('verifies the raw body and hands the event to the processor', async () => {
    const res = await webhook(signed(payload), {});
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ received: true, outcome: 'processed' });
    expect(state.handled).toEqual(['evt_test_1']);
  });
});
