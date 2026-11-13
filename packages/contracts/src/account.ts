import { z } from 'zod';

/**
 * `GET /api/v1/billing/usage` and the `/account` page (PRD §4, FR-N03): the signed-in owner's
 * plan, a small usage summary and the billing state (T28–T33). Bytes are integers (decimal GB
 * in the UI); money is integer micro-USD.
 */
export const PLAN_IDS = ['free', 'pro'] as const;
export const planIdSchema = z.enum(PLAN_IDS);

export const BILLING_ACCOUNT_STATUS_VALUES = [
  'free',
  'active',
  'past_due',
  'restricted',
  'canceled',
] as const;
export const billingAccountStatusSchema = z.enum(BILLING_ACCOUNT_STATUS_VALUES);

const bytes = z.number().int().nonnegative();

export const usageMeterSchema = z.object({
  /** Measured bytes; `null` when the meter has no data source yet (see `tracked`). */
  usedBytes: bytes.nullable(),
  /** Hard plan limit in bytes (Free), or `null` when the plan has none. */
  limitBytes: bytes.nullable(),
  /** Whole percent of `limitBytes` used (0–100, clamped); `null` without a limit or data. */
  percentUsed: z.number().int().min(0).max(100).nullable(),
  /** False until this meter is populated for the account (e.g. delivery metering, T27). */
  tracked: z.boolean(),
});
export type UsageMeter = z.infer<typeof usageMeterSchema>;

/** Why public delivery is paused by the safety cutoff (PRD §9.4, `billing_accounts`). */
export const DELIVERY_PAUSE_REASON_VALUES = ['free_delivery_cap', 'spend_cap'] as const;
export const deliveryPauseReasonSchema = z.enum(DELIVERY_PAUSE_REASON_VALUES);

const isoOrNull = z.iso.datetime().nullable();

/** Billing state shown on `/account` (T28–T33). Derived server-side; never from redirects. */
export const accountBillingSchema = z.object({
  /** Stripe is configured on this deployment; false ⇒ upgrade/portal controls are disabled. */
  paymentsEnabled: z.boolean(),
  /** A Stripe customer exists, so the Billing Portal can be opened. */
  hasCustomer: z.boolean(),
  /** Pro ends at the period end (canceled in the portal, still active until then). */
  cancelAtPeriodEnd: z.boolean(),
  uploadsAllowed: z.boolean(),
  publicDeliveryAllowed: z.boolean(),
  /** past_due: when public delivery stops; restricted/canceled: when it stopped. */
  deliverySuspendsAt: isoOrNull,
  /** End of the media-preservation window (past_due/restricted/canceled). */
  retentionEndsAt: isoOrNull,
  /** Delivery safety cutoff currently in force, if any. */
  deliveryPaused: deliveryPauseReasonSchema.nullable(),
  galleries: z.object({
    active: z.number().int().nonnegative(),
    /** Plan maximum of non-deleted galleries; null = unlimited (Pro). */
    max: z.number().int().nonnegative().nullable(),
  }),
});
export type AccountBilling = z.infer<typeof accountBillingSchema>;

export const accountUsageSummarySchema = z.object({
  email: z.string().nullable(),
  plan: planIdSchema,
  billingStatus: billingAccountStatusSchema,
  /** Current billing period (calendar month in UTC until a Stripe subscription sets one). */
  period: z.object({ start: z.iso.datetime(), end: z.iso.datetime() }),
  /** Originals plus generated derivatives currently stored, across non-deleted galleries. */
  storage: usageMeterSchema.extend({ itemCount: z.number().int().nonnegative() }),
  /** Delivered bytes this billing period, from the usage ledger. */
  delivery: usageMeterSchema,
  billing: accountBillingSchema,
});
export type AccountUsageSummary = z.infer<typeof accountUsageSummarySchema>;
