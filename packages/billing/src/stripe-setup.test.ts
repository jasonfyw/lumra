import { fileURLToPath } from 'node:url';
import {
  RATE_CARD,
  SUPERSEDED_STORAGE_PRICE,
  RETIRED_STRIPE_OBJECTS,
  STRIPE_API_VERSION,
  STRIPE_CATALOG,
  catalogLookupKeys,
} from '@lumra/config';
import { describe, expect, it } from 'vitest';
import { MICRO_USD_PER_CENT } from './units';

/**
 * `scripts/stripe-setup.mjs` must create exactly the catalog the code looks up (lookup keys,
 * meter event names) at the rate card's prices. The script is dependency-free Node, so it
 * mirrors the values; this test fails if either side drifts.
 */
interface SetupModule {
  CATALOG: {
    base: { lookupKey: string; unitAmountCents: number };
    meterUnitBytes: number;
    storage: { lookupKey: string; eventName: string; microUsdPerGb: number };
    portalKey: string;
  };
  RETIRED: { prices: string[]; meters: string[] };
  SUPERSEDED_STORAGE_PRICE: string;
  MIGRATE_STATUSES: string[];
  migrateSubscriptions(
    call: (
      method: string,
      path: string,
      params?: Record<string, unknown>,
      key?: string,
    ) => Promise<unknown>,
    dryRun: boolean,
    log: (label: string, id: string | null, action: string) => void,
  ): Promise<{ migrated: number }>;
  centsPerUnit(microUsdPerGb: number, unitBytes?: number): string;
  decimalString(numerator: number, exponent: number): string;
  STRIPE_API_VERSION: string;
}

const path = fileURLToPath(new URL('../../../scripts/stripe-setup.mjs', import.meta.url));
const setup = (await import(/* @vite-ignore */ path)) as SetupModule;

describe('scripts/stripe-setup.mjs', () => {
  const { CATALOG } = setup;
  const pro = RATE_CARD.pro;

  it('uses the catalog lookup keys and meter event names', () => {
    expect(CATALOG.base.lookupKey).toBe(STRIPE_CATALOG.prices.base);
    expect(CATALOG.storage.lookupKey).toBe(STRIPE_CATALOG.prices.storageOverage);
    expect(CATALOG.storage.eventName).toBe(STRIPE_CATALOG.meters.storageOverage);
    expect(CATALOG.meterUnitBytes).toBe(STRIPE_CATALOG.meterUnitBytes);
    expect(CATALOG.portalKey).toBe(STRIPE_CATALOG.portalConfigurationKey);
  });

  it('prices match the current RATE_CARD (v2) exactly', () => {
    expect(BigInt(CATALOG.base.unitAmountCents) * MICRO_USD_PER_CENT).toBe(
      BigInt(pro.monthlyFeeMicroUsd),
    );
    expect(CATALOG.storage.microUsdPerGb).toBe(pro.storageOverageMicroUsdPerGbMonth);
  });

  it('Checkout carries only the base and storage prices; delivery is retired (ADR-008)', () => {
    expect(catalogLookupKeys()).toEqual([CATALOG.base.lookupKey, CATALOG.storage.lookupKey]);
    // Checkout uses the v2 storage price; v1 is archived by the setup script.
    expect(STRIPE_CATALOG.prices.storageOverage).toBe('lumra_pro_storage_overage_v2');
    expect(setup.RETIRED.prices).toContain('lumra_pro_storage_overage_v1');
    expect(setup.RETIRED.prices).not.toContain(CATALOG.storage.lookupKey);
    expect(setup.SUPERSEDED_STORAGE_PRICE).toBe(SUPERSEDED_STORAGE_PRICE);
    expect(catalogLookupKeys()).not.toContain(SUPERSEDED_STORAGE_PRICE);
    expect(setup.RETIRED).toEqual({
      prices: [...RETIRED_STRIPE_OBJECTS.prices],
      meters: [...RETIRED_STRIPE_OBJECTS.meters],
    });
    expect(Object.keys(CATALOG)).not.toContain('delivery');
  });

  it('per-MB unit amounts are exact decimal cents ($0.05/GB-month → 0.005¢)', () => {
    expect(setup.centsPerUnit(CATALOG.storage.microUsdPerGb)).toBe('0.005');
    expect(setup.centsPerUnit(100_000)).toBe('0.01'); // v1 ($0.10)
    expect(setup.centsPerUnit(30_000)).toBe('0.003');
    expect(setup.decimalString(4_200_000, 6)).toBe('4.2');
    expect(setup.decimalString(7, 3)).toBe('0.007');
  });

  it('pins the same Stripe API version as the web app', () => {
    expect(setup.STRIPE_API_VERSION).toBe(STRIPE_API_VERSION);
  });
});

describe('stripe-setup --migrate-subscriptions', () => {
  const v1 = { id: 'price_v1', lookup_key: setup.SUPERSEDED_STORAGE_PRICE, active: false };
  const v2 = {
    id: 'price_v2',
    lookup_key: setup.CATALOG.storage.lookupKey,
    active: true,
    unit_amount_decimal: '0.005',
    recurring: { usage_type: 'metered' },
  };
  const sub = (id: string, status: string) => ({
    id,
    status,
    items: { data: [{ id: `si_${id}`, price: { id: 'price_v1' } }] },
  });

  function fake(subs: ReturnType<typeof sub>[]) {
    const writes: { path: string; params: Record<string, unknown>; key?: string }[] = [];
    const call = async (
      method: string,
      path: string,
      params: Record<string, unknown> = {},
      key?: string,
    ) => {
      if (method === 'GET' && path === '/v1/prices') return { data: [v1, v2] };
      if (method === 'GET' && path === '/v1/subscriptions') {
        const start = params.starting_after
          ? subs.findIndex((s) => s.id === params.starting_after) + 1
          : 0;
        const data = subs.slice(start, start + 2); // tiny pages exercise pagination
        return { data, has_more: start + 2 < subs.length };
      }
      writes.push({ path, params, key });
      return {};
    };
    return { call, writes };
  }

  const subs = [
    sub('sub_a', 'active'),
    sub('sub_b', 'canceled'),
    sub('sub_c', 'past_due'),
    sub('sub_d', 'trialing'),
  ];

  it('moves active/trialing/past_due storage items to v2 without proration; skips canceled', async () => {
    const { call, writes } = fake(subs);
    const logs: string[] = [];
    const result = await setup.migrateSubscriptions(call, false, (l, id, a) =>
      logs.push(`${l}|${id}|${a}`),
    );
    expect(result).toEqual({ migrated: 3 });
    expect(writes.map((w) => w.path)).toEqual([
      '/v1/subscriptions/sub_a',
      '/v1/subscriptions/sub_c',
      '/v1/subscriptions/sub_d',
    ]);
    expect(writes[0]).toEqual({
      path: '/v1/subscriptions/sub_a',
      params: { items: [{ id: 'si_sub_a', price: 'price_v2' }], proration_behavior: 'none' },
      key: 'lumra-migrate-sub_a-price_v2',
    });
    expect(logs.filter((l) => l.includes('sub_b'))).toEqual([]);
  });

  it('writes nothing in a dry run', async () => {
    const { call, writes } = fake(subs);
    const result = await setup.migrateSubscriptions(call, true, () => undefined);
    expect(result).toEqual({ migrated: 3 });
    expect(writes).toEqual([]);
  });

  it('is idempotent: nothing left on v1 means nothing to do', async () => {
    const { call, writes } = fake([]);
    expect(await setup.migrateSubscriptions(call, false, () => undefined)).toEqual({ migrated: 0 });
    expect(writes).toEqual([]);
  });
});
