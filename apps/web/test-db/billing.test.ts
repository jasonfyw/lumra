import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { STRIPE_CATALOG_V1 } from '@lumra/config';
import { POST as checkout } from '../src/app/api/v1/billing/checkout/route';
import { POST as portal } from '../src/app/api/v1/billing/portal/route';
import { POST as webhook } from '../src/app/api/v1/billing/webhook/route';
import { getDb } from '../src/lib/db';
import { resetServerEnvForTests } from '../src/lib/env';
import { evaluateAccountAdmission } from '../src/server/admission';
import { findViewableGallery } from '../src/server/public-gallery';
import { setStripeForTests } from '../src/server/stripe';
import {
  cleanup,
  createOwnedGallery,
  createUser,
  jsonRequest,
  readJson,
  resetContext,
  signInAs,
  slug,
  sql,
} from './fixtures';

/**
 * Billing core against Postgres (T28–T30, T33): checkout/portal authorization, signed webhooks
 * driving the account state machine, replay dedupe (G-06), outbox side effects, and the public
 * delivery consequences. Stripe is a recording fake; signatures use the real SDK verifier.
 */

const WEBHOOK_SECRET = 'whsec_billingtest0123456789abcdef';
const DAY = 86_400_000;

const calls = {
  customers: [] as { params: Stripe.CustomerCreateParams; key?: string }[],
  sessions: [] as Stripe.Checkout.SessionCreateParams[],
  portals: [] as Stripe.BillingPortal.SessionCreateParams[],
};

const fakeStripe = {
  webhooks: Stripe.webhooks,
  customers: {
    create: vi.fn(async (params: Stripe.CustomerCreateParams, opts?: Stripe.RequestOptions) => {
      calls.customers.push({ params, key: opts?.idempotencyKey });
      return { id: `cus_${randomUUID().slice(0, 8)}` };
    }),
  },
  prices: {
    list: vi.fn(async (params: Stripe.PriceListParams) => ({
      data: (params.lookup_keys ?? []).map((k) => ({ id: `price_${k}`, lookup_key: k })),
    })),
  },
  checkout: {
    sessions: {
      create: vi.fn(async (params: Stripe.Checkout.SessionCreateParams) => {
        calls.sessions.push(params);
        return { url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
      }),
    },
  },
  billingPortal: {
    configurations: {
      list: vi.fn(async () => ({
        data: [{ id: 'bpc_lumra', metadata: { lumra_config: 'lumra_portal_v1' } }],
      })),
    },
    sessions: {
      create: vi.fn(async (params: Stripe.BillingPortal.SessionCreateParams) => {
        calls.portals.push(params);
        return { url: 'https://billing.stripe.com/p/session/test_1' };
      }),
    },
  },
} as unknown as Stripe;

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_51billingtestkey';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  resetServerEnvForTests();
  setStripeForTests(fakeStripe);
});

beforeEach(() => {
  resetContext();
  calls.customers.length = 0;
  calls.sessions.length = 0;
  calls.portals.length = 0;
});

const createdUsers: string[] = [];
afterAll(async () => {
  if (createdUsers.length) {
    await sql`delete from public.job_outbox where aggregate_id in ${sql(createdUsers)}
              or (event_name = 'gallery.access_changed' and aggregate_id in (
                select id from public.galleries where owner_id in ${sql(createdUsers)}))`;
    await sql`delete from public.provider_webhook_events where account_id in ${sql(createdUsers)}`;
  }
  setStripeForTests(undefined);
  await cleanup();
});

async function newUser(plan: 'free' | 'pro' = 'free') {
  const id = await createUser(plan);
  createdUsers.push(id);
  return id;
}

async function publishedGallery(ownerId: string) {
  const [row] = await sql<{ id: string; slug: string }[]>`
    insert into public.galleries (owner_id, slug, title, status, published_at)
    values (${ownerId}, ${slug()}, 'Shared', 'published', now()) returning id, slug`;
  return row!;
}

async function account(userId: string) {
  const [row] = await sql<
    {
      status: string;
      plan_id: string;
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
      past_due_since: Date | null;
      canceled_at: Date | null;
      billing_period_start: Date | null;
      delivery_paused_reason: string | null;
      cancel_at_period_end: boolean;
    }[]
  >`
    select ba.status, p.plan_id, ba.stripe_customer_id, ba.stripe_subscription_id,
           ba.past_due_since, ba.canceled_at, ba.billing_period_start, ba.delivery_paused_reason,
           ba.cancel_at_period_end
    from public.billing_accounts ba join public.profiles p on p.user_id = ba.user_id
    where ba.user_id = ${userId}`;
  return row!;
}

const outbox = (aggregateIds: string[], event?: string) =>
  sql<{ event_name: string; payload: { template?: string } }[]>`
    select event_name, payload from public.job_outbox
    where aggregate_id in ${sql(aggregateIds)} ${event ? sql`and event_name = ${event}` : sql``}
    order by created_at`;

let seq = 0;
function subscriptionEvent(
  type:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted',
  sub: {
    customer: string;
    status: string;
    id?: string;
    userId?: string;
    cancelAtPeriodEnd?: boolean;
  },
  createdSeconds = Math.floor(Date.now() / 1000) + seq,
) {
  seq += 1;
  const start = Math.floor(Date.UTC(2026, 10, 13, 10) / 1000);
  return {
    id: `evt_${randomUUID().replaceAll('-', '')}`,
    object: 'event',
    type,
    created: createdSeconds,
    data: {
      object: {
        id: sub.id ?? `sub_${sub.customer}`,
        object: 'subscription',
        customer: sub.customer,
        status: sub.status,
        cancel_at_period_end: sub.cancelAtPeriodEnd ?? false,
        cancel_at: null,
        metadata: sub.userId ? { lumra_user_id: sub.userId } : {},
        items: {
          object: 'list',
          data: [
            { id: 'si_1', current_period_start: start, current_period_end: start + 30 * 86_400 },
          ],
        },
      },
    },
  };
}

async function deliver(event: object) {
  const body = JSON.stringify(event);
  const res = await webhook(
    new Request('http://localhost:3000/api/v1/billing/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': Stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret: WEBHOOK_SECRET,
        }),
      },
      body,
    }),
    {},
  );
  return { status: res.status, body: await readJson<{ outcome: string }>(res) };
}

async function linkCustomer(userId: string) {
  const customer = `cus_${randomUUID().slice(0, 12)}`;
  await sql`update public.billing_accounts set stripe_customer_id = ${customer} where user_id = ${userId}`;
  return customer;
}

describe('POST /api/v1/billing/checkout', () => {
  it('401 when signed out; never touches Stripe', async () => {
    const res = await checkout(jsonRequest('/api/v1/billing/checkout', { body: {} }), {});
    expect(res.status).toBe(401);
    expect(calls.sessions).toHaveLength(0);
  });

  it('creates one customer and a subscription checkout with base + both metered prices', async () => {
    const user = await newUser();
    signInAs(user);
    const res = await checkout(jsonRequest('/api/v1/billing/checkout', { body: {} }), {});
    expect(res.status).toBe(200);
    expect((await readJson<{ url: string }>(res)).data?.url).toMatch(/^https:\/\/checkout\.stripe/);
    expect(calls.customers).toEqual([
      {
        params: { email: `${user}@example.test`, metadata: { lumra_user_id: user } },
        key: `lumra-customer-${user}`,
      },
    ]);
    const [session] = calls.sessions;
    expect(session).toMatchObject({
      mode: 'subscription',
      client_reference_id: user,
      subscription_data: { metadata: { lumra_user_id: user } },
      line_items: [
        { price: `price_${STRIPE_CATALOG_V1.prices.base}`, quantity: 1 },
        { price: `price_${STRIPE_CATALOG_V1.prices.storageOverage}` },
        { price: `price_${STRIPE_CATALOG_V1.prices.deliveryOverage}` },
      ],
    });
    expect(session?.success_url).toBe('https://lumra.test/account?checkout=success');
    const stored = await account(user);
    expect(session?.customer).toBe(stored.stripe_customer_id);
    // The redirect grants nothing: still Free until the webhook confirms.
    expect(stored).toMatchObject({ status: 'free', plan_id: 'free' });

    // A second checkout reuses the stored customer.
    await checkout(jsonRequest('/api/v1/billing/checkout', { body: {} }), {});
    expect(calls.customers).toHaveLength(1);
  });

  it('409 when the account already has a live subscription', async () => {
    const user = await newUser('pro');
    await sql`update public.billing_accounts set status = 'active' where user_id = ${user}`;
    signInAs(user);
    const res = await checkout(jsonRequest('/api/v1/billing/checkout', { body: {} }), {});
    expect(res.status).toBe(409);
  });
});

describe('POST /api/v1/billing/portal', () => {
  it('401 when signed out, 409 without a customer, URL for the owner’s own customer', async () => {
    expect((await portal(jsonRequest('/api/v1/billing/portal', { body: {} }), {})).status).toBe(
      401,
    );
    const user = await newUser();
    signInAs(user);
    expect((await portal(jsonRequest('/api/v1/billing/portal', { body: {} }), {})).status).toBe(
      409,
    );
    const customer = await linkCustomer(user);
    const res = await portal(jsonRequest('/api/v1/billing/portal', { body: {} }), {});
    expect(res.status).toBe(200);
    expect(calls.portals).toEqual([
      { customer, return_url: 'https://lumra.test/account', configuration: 'bpc_lumra' },
    ]);
  });
});

describe('POST /api/v1/billing/webhook (T29/T30/T33)', () => {
  it('activates Pro exactly once; a replayed event is a no-op (G-06)', async () => {
    const user = await newUser();
    const customer = await linkCustomer(user);
    const gallery = await publishedGallery(user);
    expect((await findViewableGallery(getDb(), gallery.slug)).brandingVisible).toBe(true);

    const created = subscriptionEvent('customer.subscription.created', {
      customer,
      status: 'incomplete',
    });
    expect((await deliver(created)).body.data?.outcome).toBe('ignored');
    expect(await account(user)).toMatchObject({ status: 'free', plan_id: 'free' });

    const activated = subscriptionEvent('customer.subscription.updated', {
      customer,
      status: 'active',
    });
    const first = await deliver(activated);
    expect(first.status).toBe(200);
    expect(first.body.data?.outcome).toBe('processed');
    const after = await account(user);
    expect(after).toMatchObject({
      status: 'active',
      plan_id: 'pro',
      stripe_subscription_id: `sub_${customer}`,
    });
    expect(after.billing_period_start).toEqual(new Date(Date.UTC(2026, 10, 13, 10)));
    // Plan switch updates branding: Pro hides "Made with Lumra".
    expect((await findViewableGallery(getDb(), gallery.slug)).brandingVisible).toBe(false);

    const emails = await outbox([user], 'email.send');
    expect(emails.map((e) => e.payload.template)).toEqual(['pro_activated']);
    const syncs = await outbox([gallery.id], 'gallery.access_changed');
    expect(syncs).toHaveLength(1);

    // Replay: same event id → no state change, no new outbox rows.
    const replay = await deliver(activated);
    expect(replay.status).toBe(200);
    expect(replay.body.data?.outcome).toBe('duplicate');
    expect(await outbox([user], 'email.send')).toHaveLength(1);
    expect(await outbox([gallery.id], 'gallery.access_changed')).toHaveLength(1);
    const [events] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.provider_webhook_events where provider_event_id = ${activated.id}`;
    expect(events!.n).toBe(1);

    // A further "active" update (e.g. renewal) sends no second activation notice.
    await deliver(
      subscriptionEvent('customer.subscription.updated', { customer, status: 'active' }),
    );
    expect(await outbox([user], 'email.send')).toHaveLength(1);
  });

  it('maps by metadata when the customer was not linked yet; ignores unknown customers', async () => {
    const user = await newUser();
    const customer = `cus_${randomUUID().slice(0, 12)}`;
    await deliver(
      subscriptionEvent('customer.subscription.created', {
        customer,
        status: 'active',
        userId: user,
      }),
    );
    expect(await account(user)).toMatchObject({ status: 'active', stripe_customer_id: customer });

    const unknown = await deliver(
      subscriptionEvent('customer.subscription.created', {
        customer: 'cus_nobody',
        status: 'active',
      }),
    );
    expect(unknown.body.data?.outcome).toBe('ignored');
  });

  it('past_due stops uploads at once, keeps delivery for the grace, then suspends it', async () => {
    const user = await newUser();
    const customer = await linkCustomer(user);
    const gallery = await publishedGallery(user);
    await deliver(
      subscriptionEvent('customer.subscription.created', { customer, status: 'active' }),
    );
    await deliver(
      subscriptionEvent('customer.subscription.updated', { customer, status: 'past_due' }),
    );
    const state = await account(user);
    expect(state.status).toBe('past_due');
    expect(state.past_due_since).not.toBeNull();
    expect((await outbox([user], 'email.send')).map((e) => e.payload.template)).toEqual([
      'pro_activated',
      'payment_failed',
    ]);

    const decision = await getDb().transaction((tx) =>
      evaluateAccountAdmission(tx, user, { kind: 'upload', bytes: 1_000_000 }, new Date()),
    );
    expect(decision).toMatchObject({ allowed: false, reason: 'past_due' });
    // Inside the 7-day grace the shared gallery still works …
    await expect(findViewableGallery(getDb(), gallery.slug)).resolves.toMatchObject({
      id: gallery.id,
    });
    // … and after it (time travel) recipients get the calm "temporarily unavailable".
    await expect(
      findViewableGallery(getDb(), gallery.slug, new Date(Date.now() + 8 * DAY)),
    ).rejects.toMatchObject({ error: { code: 'gallery_unavailable' } });

    // Payment recovered.
    await deliver(
      subscriptionEvent('customer.subscription.updated', { customer, status: 'active' }),
    );
    expect(await account(user)).toMatchObject({ status: 'active', past_due_since: null });
  });

  it('cancellation: back to Free when within Free caps, else canceled (offline, media kept)', async () => {
    const small = await newUser();
    const smallCustomer = await linkCustomer(small);
    await deliver(
      subscriptionEvent('customer.subscription.created', {
        customer: smallCustomer,
        status: 'active',
      }),
    );
    await deliver(
      subscriptionEvent('customer.subscription.updated', {
        customer: smallCustomer,
        status: 'active',
        cancelAtPeriodEnd: true,
      }),
    );
    expect(await account(small)).toMatchObject({ status: 'active', cancel_at_period_end: true });
    await deliver(
      subscriptionEvent('customer.subscription.deleted', {
        customer: smallCustomer,
        status: 'canceled',
      }),
    );
    expect(await account(small)).toMatchObject({
      status: 'free',
      plan_id: 'free',
      billing_period_start: null,
    });

    const big = await newUser();
    const bigCustomer = await linkCustomer(big);
    await deliver(
      subscriptionEvent('customer.subscription.created', {
        customer: bigCustomer,
        status: 'active',
      }),
    );
    for (let i = 0; i < 3; i++) await createOwnedGallery(big);
    const gallery = await publishedGallery(big);
    await deliver(
      subscriptionEvent('customer.subscription.deleted', {
        customer: bigCustomer,
        status: 'canceled',
      }),
    );
    const state = await account(big);
    expect(state).toMatchObject({ status: 'canceled', plan_id: 'free' });
    expect(state.canceled_at).not.toBeNull();
    await expect(findViewableGallery(getDb(), gallery.slug)).rejects.toMatchObject({
      error: { code: 'gallery_unavailable' },
    });
  });

  it('an upgrade lifts a Free delivery-cap pause right away', async () => {
    const user = await newUser();
    const customer = await linkCustomer(user);
    const gallery = await publishedGallery(user);
    await sql`update public.billing_accounts
              set delivery_paused_reason = 'free_delivery_cap', delivery_paused_at = now()
              where user_id = ${user}`;
    await expect(findViewableGallery(getDb(), gallery.slug)).rejects.toMatchObject({
      error: { code: 'gallery_unavailable' },
    });
    await deliver(
      subscriptionEvent('customer.subscription.created', { customer, status: 'active' }),
    );
    expect((await account(user)).delivery_paused_reason).toBeNull();
    await expect(findViewableGallery(getDb(), gallery.slug)).resolves.toMatchObject({
      id: gallery.id,
    });
  });

  it('checkout.session.completed links the customer but grants nothing', async () => {
    const user = await newUser();
    const res = await deliver({
      id: `evt_${randomUUID().replaceAll('-', '')}`,
      object: 'event',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'cs_test_1',
          object: 'checkout.session',
          mode: 'subscription',
          client_reference_id: user,
          customer: 'cus_fromcheckout1',
        },
      },
    });
    expect(res.body.data?.outcome).toBe('processed');
    expect(await account(user)).toMatchObject({
      status: 'free',
      plan_id: 'free',
      stripe_customer_id: 'cus_fromcheckout1',
    });
  });

  it('rejects unsigned deliveries', async () => {
    const res = await webhook(
      new Request('http://localhost:3000/api/v1/billing/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': 't=1,v1=deadbeef' },
        body: '{}',
      }),
      {},
    );
    expect(res.status).toBe(422);
  });
});
