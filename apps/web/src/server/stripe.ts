import 'server-only';
import Stripe from 'stripe';
import {
  STRIPE_API_VERSION,
  STRIPE_CATALOG_V1,
  catalogLookupKeys,
  type StripeCatalog,
} from '@lumra/config';
import { serverEnv } from '@/lib/env';

/**
 * Stripe client (T29). Server-only, Node runtime. The API version is pinned so a Stripe-side
 * default change can never alter payload shapes under us; bump it deliberately together with the
 * `stripe` package. Absent `STRIPE_SECRET_KEY` ⇒ `null`: billing degrades gracefully (buttons
 * disabled, endpoints answer `billing_unavailable`), nothing crashes.
 */
export { STRIPE_API_VERSION };

let client: Stripe | null | undefined;

export function getStripe(): Stripe | null {
  if (client !== undefined) return client;
  const key = serverEnv().STRIPE_SECRET_KEY;
  client = key
    ? new Stripe(key, {
        apiVersion: STRIPE_API_VERSION,
        maxNetworkRetries: 2,
        timeout: 15_000,
        appInfo: { name: 'Lumra' },
      })
    : null;
  return client;
}

/** True when checkout/portal can work on this deployment. */
export function isBillingConfigured(): boolean {
  return Boolean(serverEnv().STRIPE_SECRET_KEY);
}

/** Test hook. */
export function setStripeForTests(stripe: Stripe | null | undefined): void {
  client = stripe;
  priceCache = null;
  portalCache = null;
}

export class StripeCatalogError extends Error {
  constructor(readonly missing: string[]) {
    super(`Stripe catalog incomplete: missing active prices for ${missing.join(', ')}`);
    this.name = 'StripeCatalogError';
  }
}

export interface CatalogPrices {
  base: string;
  storageOverage: string;
  deliveryOverage: string;
}

const CACHE_MS = 10 * 60 * 1000;
let priceCache: { at: number; prices: CatalogPrices } | null = null;
let portalCache: { at: number; id: string | null } | null = null;

/**
 * Price ids for the catalog's lookup keys (one `prices.list` call, cached 10 min). Throws
 * `StripeCatalogError` naming the missing keys (run `scripts/stripe-setup.mjs`).
 */
export async function resolveCatalogPrices(
  stripe: Stripe,
  catalog: StripeCatalog = STRIPE_CATALOG_V1,
  nowMs = Date.now(),
): Promise<CatalogPrices> {
  if (priceCache && nowMs - priceCache.at < CACHE_MS) return priceCache.prices;
  const keys = catalogLookupKeys(catalog);
  const list = await stripe.prices.list({ lookup_keys: keys, active: true, limit: keys.length });
  const byKey = new Map(list.data.map((p) => [p.lookup_key, p.id]));
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length > 0) throw new StripeCatalogError(missing);
  const prices: CatalogPrices = {
    base: byKey.get(catalog.prices.base)!,
    storageOverage: byKey.get(catalog.prices.storageOverage)!,
    deliveryOverage: byKey.get(catalog.prices.deliveryOverage)!,
  };
  priceCache = { at: nowMs, prices };
  return prices;
}

/**
 * The Billing Portal configuration created by `scripts/stripe-setup.mjs`
 * (`metadata.lumra_config`), or null to use the account default. Cached 10 min.
 */
export async function resolvePortalConfiguration(
  stripe: Stripe,
  catalog: StripeCatalog = STRIPE_CATALOG_V1,
  nowMs = Date.now(),
): Promise<string | null> {
  if (portalCache && nowMs - portalCache.at < CACHE_MS) return portalCache.id;
  const list = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  const match = list.data.find((c) => c.metadata?.lumra_config === catalog.portalConfigurationKey);
  portalCache = { at: nowMs, id: match?.id ?? null };
  return portalCache.id;
}

/** `string | {id}` Stripe expandable → id. */
export function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}
