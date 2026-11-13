/**
 * Stripe API version pinned by the web app (`stripe` SDK) and `scripts/stripe-setup.mjs`, so a
 * Stripe-side default change never alters payload shapes. Bump together with the SDK.
 */
export const STRIPE_API_VERSION = '2026-10-28.endive' as const;

/**
 * Stripe catalog for rate card v1 (T29/T31, ADR-004 amendment 2026-11-13, ADR-008). Code finds prices by
 * **lookup key**, never by id, so the same build works against test and live mode. The objects
 * are created idempotently by `scripts/stripe-setup.mjs`, which mirrors these values (a unit
 * test in `@lumra/billing` checks the script against this constant and `RATE_CARD_V1`).
 *
 * The meter carries **storage overage only** (Lumra subtracts the included allowance itself) as
 * an integer: MB-months above the included GB-months (1 MB-month = 10⁶ byte × 30-day month).
 * The metered price is flat per unit (`unit_amount_decimal` in cents): the rate per GB ÷ 1000.
 * Delivery is not billed (ADR-008); the retired delivery price/meter are listed in
 * `RETIRED_STRIPE_OBJECTS` so the setup script can archive them.
 * A rate change ships new lookup keys (`…_v2`) together with a new `rateVersion`.
 */
export interface StripeCatalog {
  rateVersion: number;
  productName: string;
  /** `metadata.lumra_product` on the product, used by the setup script to find it again. */
  productKey: string;
  prices: {
    base: string;
    storageOverage: string;
  };
  meters: {
    storageOverage: string;
  };
  /** Bytes per meter unit: storage counts MB-months. */
  meterUnitBytes: number;
  /** `metadata.lumra_config` on the Billing Portal configuration created by the setup script. */
  portalConfigurationKey: string;
}

export const STRIPE_CATALOG_V1: StripeCatalog = {
  rateVersion: 1,
  productName: 'Lumra Pro',
  productKey: 'lumra_pro',
  prices: {
    base: 'lumra_pro_monthly_v1',
    storageOverage: 'lumra_pro_storage_overage_v1',
  },
  meters: {
    storageOverage: 'lumra_storage_overage',
  },
  meterUnitBytes: 1_000_000,
  portalConfigurationKey: 'lumra_portal_v1',
};

/** Every lookup key Checkout puts on a Pro subscription: base fee + the storage metered price. */
export function catalogLookupKeys(catalog: StripeCatalog = STRIPE_CATALOG_V1): string[] {
  return [catalog.prices.base, catalog.prices.storageOverage];
}

/**
 * Stripe objects of the removed delivery charge (ADR-008). `scripts/stripe-setup.mjs
 * --archive-legacy` archives the price and deactivates the meter; existing subscriptions that
 * still carry the price keep it until the owner migrates them (its meter receives no events).
 */
export const RETIRED_STRIPE_OBJECTS = {
  prices: ['lumra_pro_delivery_overage_v1'],
  meters: ['lumra_delivery_overage'],
} as const;
