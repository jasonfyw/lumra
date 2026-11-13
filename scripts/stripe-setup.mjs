#!/usr/bin/env node
/**
 * Idempotent Stripe catalog setup for Lumra Pro (T29/T31, docs/BILLING.md "Stripe setup").
 *
 *   STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs [--dry-run] [--app-url https://www.lumra.photos]
 *
 * Runs against whichever mode the key belongs to (test or live) and ensures:
 *   - the "Lumra Pro" product and its $2/month base price (lookup key lumra_pro_monthly_v1);
 *   - Billing Meters `lumra_storage_overage` (MB-months above the included allowance) and
 *     `lumra_delivery_overage` (MB above the included allowance), sum aggregation, by customer id;
 *   - flat per-unit metered prices on those meters (lookup keys lumra_pro_storage_overage_v1,
 *     lumra_pro_delivery_overage_v1): the rate per GB ÷ 1000, in fractional cents;
 *   - the Billing Portal configuration (metadata lumra_config=lumra_portal_v1).
 * Existing objects are found by lookup key / event name / metadata and reused; an existing price
 * whose amount or meter differs is reported as an error (prices are immutable: ship `_v2` keys).
 * Prints object ids only — never the key. Zero dependencies (Node ≥ 22 `fetch`).
 *
 * Values mirror STRIPE_CATALOG_V1 + RATE_CARD_V1 in @lumra/config; a unit test in
 * packages/billing (stripe-setup.test.ts) fails if they drift.
 */
import { pathToFileURL } from 'node:url';

export const STRIPE_API_VERSION = '2026-10-28.endive';

export const CATALOG = {
  productKey: 'lumra_pro',
  productName: 'Lumra Pro',
  currency: 'usd',
  base: { lookupKey: 'lumra_pro_monthly_v1', unitAmountCents: 200 },
  // Rates in micro-USD per GB(-month) from RATE_CARD_V1.pro; meter units are MB (10^6 bytes).
  meterUnitBytes: 1_000_000,
  storage: {
    lookupKey: 'lumra_pro_storage_overage_v1',
    eventName: 'lumra_storage_overage',
    displayName: 'Lumra storage overage (MB-month)',
    microUsdPerGb: 100_000,
  },
  delivery: {
    lookupKey: 'lumra_pro_delivery_overage_v1',
    eventName: 'lumra_delivery_overage',
    displayName: 'Lumra delivery overage (MB)',
    microUsdPerGb: 30_000,
  },
  portalKey: 'lumra_portal_v1',
};

/**
 * Exact decimal string for `numerator / 10^exponent` (no floating point): 100000 / 10^7 → "0.01".
 */
export function decimalString(numerator, exponent) {
  const digits = BigInt(numerator)
    .toString()
    .padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const frac = digits.slice(digits.length - exponent).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** Cents per meter unit: µ$/GB × (unit bytes / 10^9) ÷ 10^4 µ$/¢. MB units ⇒ ÷ 10^7. */
export function centsPerUnit(microUsdPerGb, unitBytes = CATALOG.meterUnitBytes) {
  const unitsPerGb = 1_000_000_000 / unitBytes; // 1000 for MB
  const exponent = Math.round(Math.log10(unitsPerGb)) + 4;
  return decimalString(microUsdPerGb, exponent);
}

const normalizeDecimal = (value) =>
  value == null
    ? null
    : String(value)
        .replace(/(\.\d*?)0+$/, '$1')
        .replace(/\.$/, '');

// ---------------------------------------------------------------------------------------------
// tiny Stripe REST client (form-encoded, pinned API version)
// ---------------------------------------------------------------------------------------------

function encode(params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) =>
        typeof v === 'object'
          ? encode(v, `${name}[${i}]`, out)
          : out.append(`${name}[${i}]`, String(v)),
      );
    } else if (typeof value === 'object') encode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

function client(key) {
  return async function call(method, path, params = {}, idempotencyKey) {
    const body = method === 'GET' ? null : encode(params).toString();
    const query = method === 'GET' ? `?${encode(params).toString()}` : '';
    const res = await fetch(`https://api.stripe.com${path}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Stripe-Version': STRIPE_API_VERSION,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body,
    });
    const json = await res.json();
    if (!res.ok) {
      const err = new Error(`${method} ${path}: ${json?.error?.message ?? res.status}`);
      err.code = json?.error?.code;
      throw err;
    }
    return json;
  };
}

// ---------------------------------------------------------------------------------------------
// ensure* steps
// ---------------------------------------------------------------------------------------------

async function pricesByLookupKey(call) {
  const keys = [CATALOG.base.lookupKey, CATALOG.storage.lookupKey, CATALOG.delivery.lookupKey];
  const list = await call('GET', '/v1/prices', {
    lookup_keys: keys,
    limit: 10,
    expand: ['data.product'],
  });
  return new Map(list.data.map((p) => [p.lookup_key, p]));
}

async function ensureProduct(call, prices, dryRun) {
  const fromPrice = prices.get(CATALOG.base.lookupKey)?.product;
  if (fromPrice && typeof fromPrice === 'object')
    return { product: fromPrice, action: 'found (base price)' };
  const list = await call('GET', '/v1/products', { active: true, limit: 100 });
  const byMeta = list.data.find((p) => p.metadata?.lumra_product === CATALOG.productKey);
  const byName = list.data.find((p) => p.name === CATALOG.productName);
  const existing = byMeta ?? byName;
  if (existing) {
    if (!byMeta && !dryRun) {
      await call('POST', `/v1/products/${existing.id}`, {
        metadata: { lumra_product: CATALOG.productKey },
      });
    }
    return { product: existing, action: byMeta ? 'found' : 'found (by name, tagged)' };
  }
  if (dryRun) return { product: null, action: 'would create' };
  const product = await call(
    'POST',
    '/v1/products',
    { name: CATALOG.productName, metadata: { lumra_product: CATALOG.productKey } },
    `lumra-setup-product-${CATALOG.productKey}`,
  );
  return { product, action: 'created' };
}

async function ensureBasePrice(call, prices, productId, dryRun) {
  const existing = prices.get(CATALOG.base.lookupKey);
  if (existing) {
    const ok =
      existing.unit_amount === CATALOG.base.unitAmountCents &&
      existing.currency === CATALOG.currency &&
      existing.recurring?.interval === 'month' &&
      existing.recurring?.usage_type !== 'metered';
    if (!ok)
      throw new Error(
        `price ${CATALOG.base.lookupKey} exists with different terms; ship a _v2 key`,
      );
    return { price: existing, action: 'found' };
  }
  if (dryRun) return { price: null, action: 'would create' };
  const price = await call(
    'POST',
    '/v1/prices',
    {
      product: productId,
      currency: CATALOG.currency,
      unit_amount: CATALOG.base.unitAmountCents,
      recurring: { interval: 'month' },
      lookup_key: CATALOG.base.lookupKey,
      nickname: 'Lumra Pro monthly (v1)',
    },
    `lumra-setup-price-${CATALOG.base.lookupKey}`,
  );
  return { price, action: 'created' };
}

async function ensureMeter(call, spec, dryRun) {
  const list = await call('GET', '/v1/billing/meters', { status: 'active', limit: 100 });
  const existing = list.data.find((m) => m.event_name === spec.eventName);
  if (existing) {
    if (existing.default_aggregation?.formula !== 'sum') {
      throw new Error(`meter ${spec.eventName} exists but does not aggregate by sum`);
    }
    return { meter: existing, action: 'found' };
  }
  if (dryRun) return { meter: null, action: 'would create' };
  const meter = await call(
    'POST',
    '/v1/billing/meters',
    {
      display_name: spec.displayName,
      event_name: spec.eventName,
      default_aggregation: { formula: 'sum' },
      customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
      value_settings: { event_payload_key: 'value' },
    },
    `lumra-setup-meter-${spec.eventName}`,
  );
  return { meter, action: 'created' };
}

async function ensureMeteredPrice(call, prices, spec, productId, meterId, dryRun) {
  const amount = centsPerUnit(spec.microUsdPerGb);
  const existing = prices.get(spec.lookupKey);
  if (existing) {
    const ok =
      existing.currency === CATALOG.currency &&
      existing.recurring?.usage_type === 'metered' &&
      existing.recurring?.interval === 'month' &&
      (meterId === null || existing.recurring?.meter === meterId) &&
      normalizeDecimal(existing.unit_amount_decimal) === normalizeDecimal(amount);
    if (!ok) throw new Error(`price ${spec.lookupKey} exists with different terms; ship a _v2 key`);
    return { price: existing, action: 'found' };
  }
  if (dryRun) return { price: null, action: `would create (${amount}¢ per unit)` };
  const price = await call(
    'POST',
    '/v1/prices',
    {
      product: productId,
      currency: CATALOG.currency,
      billing_scheme: 'per_unit',
      unit_amount_decimal: amount,
      recurring: { interval: 'month', usage_type: 'metered', meter: meterId },
      lookup_key: spec.lookupKey,
      nickname: spec.displayName,
    },
    `lumra-setup-price-${spec.lookupKey}`,
  );
  return { price, action: 'created' };
}

async function ensurePortal(call, appUrl, dryRun) {
  const params = {
    business_profile: { headline: 'Manage your Lumra Pro subscription' },
    features: {
      customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
    },
    ...(appUrl ? { default_return_url: `${appUrl.replace(/\/$/, '')}/account` } : {}),
    metadata: { lumra_config: CATALOG.portalKey },
  };
  const list = await call('GET', '/v1/billing_portal/configurations', { active: true, limit: 100 });
  const existing = list.data.find((c) => c.metadata?.lumra_config === CATALOG.portalKey);
  if (dryRun)
    return { configuration: existing ?? null, action: existing ? 'found' : 'would create' };
  if (existing) {
    const configuration = await call(
      'POST',
      `/v1/billing_portal/configurations/${existing.id}`,
      params,
    );
    return { configuration, action: 'updated' };
  }
  const configuration = await call(
    'POST',
    '/v1/billing_portal/configurations',
    params,
    `lumra-setup-portal-${CATALOG.portalKey}`,
  );
  return { configuration, action: 'created' };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key || !/^(sk|rk)_(test|live)_/.test(key)) {
    console.error('Set STRIPE_SECRET_KEY to a Stripe secret key (sk_test_… or sk_live_…).');
    return 1;
  }
  const dryRun = argv.includes('--dry-run');
  const appUrlIndex = argv.indexOf('--app-url');
  const appUrl = appUrlIndex >= 0 ? argv[appUrlIndex + 1] : env.NEXT_PUBLIC_APP_URL;
  const mode = key.includes('_live_') ? 'LIVE' : 'test';
  const call = client(key);
  const log = (label, id, action) => console.log(`${label.padEnd(26)} ${id ?? '-'}  (${action})`);

  console.log(`Stripe mode: ${mode}${dryRun ? ' — dry run, nothing will be written' : ''}`);
  const prices = await pricesByLookupKey(call);
  const { product, action: productAction } = await ensureProduct(call, prices, dryRun);
  log('product', product?.id, productAction);
  const base = await ensureBasePrice(call, prices, product?.id, dryRun);
  log(`price ${CATALOG.base.lookupKey}`, base.price?.id, base.action);
  for (const spec of [CATALOG.storage, CATALOG.delivery]) {
    const { meter, action } = await ensureMeter(call, spec, dryRun);
    log(`meter ${spec.eventName}`, meter?.id, action);
    const price = await ensureMeteredPrice(
      call,
      prices,
      spec,
      product?.id,
      meter?.id ?? null,
      dryRun,
    );
    log(`price ${spec.lookupKey}`, price.price?.id, price.action);
  }
  const portal = await ensurePortal(call, appUrl, dryRun);
  log('portal configuration', portal.configuration?.id, portal.action);
  console.log('Done. Code finds prices by lookup key; no ids need to be configured.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      // Messages come from Stripe errors and never contain the key.
      console.error(`stripe-setup failed: ${error.message}`);
      process.exit(1);
    },
  );
}
