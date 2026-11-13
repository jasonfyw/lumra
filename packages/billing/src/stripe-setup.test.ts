import { fileURLToPath } from 'node:url';
import { RATE_CARD_V1, STRIPE_API_VERSION, STRIPE_CATALOG_V1 } from '@lumra/config';
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
    delivery: { lookupKey: string; eventName: string; microUsdPerGb: number };
    portalKey: string;
  };
  centsPerUnit(microUsdPerGb: number, unitBytes?: number): string;
  decimalString(numerator: number, exponent: number): string;
  STRIPE_API_VERSION: string;
}

const path = fileURLToPath(new URL('../../../scripts/stripe-setup.mjs', import.meta.url));
const setup = (await import(/* @vite-ignore */ path)) as SetupModule;

describe('scripts/stripe-setup.mjs', () => {
  const { CATALOG } = setup;
  const pro = RATE_CARD_V1.pro;

  it('uses the catalog lookup keys and meter event names', () => {
    expect(CATALOG.base.lookupKey).toBe(STRIPE_CATALOG_V1.prices.base);
    expect(CATALOG.storage.lookupKey).toBe(STRIPE_CATALOG_V1.prices.storageOverage);
    expect(CATALOG.delivery.lookupKey).toBe(STRIPE_CATALOG_V1.prices.deliveryOverage);
    expect(CATALOG.storage.eventName).toBe(STRIPE_CATALOG_V1.meters.storageOverage);
    expect(CATALOG.delivery.eventName).toBe(STRIPE_CATALOG_V1.meters.deliveryOverage);
    expect(CATALOG.meterUnitBytes).toBe(STRIPE_CATALOG_V1.meterUnitBytes);
    expect(CATALOG.portalKey).toBe(STRIPE_CATALOG_V1.portalConfigurationKey);
  });

  it('prices match RATE_CARD_V1 exactly', () => {
    expect(BigInt(CATALOG.base.unitAmountCents) * MICRO_USD_PER_CENT).toBe(
      BigInt(pro.monthlyFeeMicroUsd),
    );
    expect(CATALOG.storage.microUsdPerGb).toBe(pro.storageOverageMicroUsdPerGbMonth);
    expect(CATALOG.delivery.microUsdPerGb).toBe(pro.deliveryOverageMicroUsdPerGb);
  });

  it('per-MB unit amounts are exact decimal cents ($0.10/GB-month → 0.01¢, $0.03/GB → 0.003¢)', () => {
    expect(setup.centsPerUnit(CATALOG.storage.microUsdPerGb)).toBe('0.01');
    expect(setup.centsPerUnit(CATALOG.delivery.microUsdPerGb)).toBe('0.003');
    expect(setup.decimalString(4_200_000, 6)).toBe('4.2');
    expect(setup.decimalString(7, 3)).toBe('0.007');
  });

  it('pins the same Stripe API version as the web app', () => {
    expect(setup.STRIPE_API_VERSION).toBe(STRIPE_API_VERSION);
  });
});
