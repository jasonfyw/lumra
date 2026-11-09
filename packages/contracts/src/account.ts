import { z } from 'zod';

/**
 * `GET /api/v1/billing/usage` and the `/account` page (PRD §4, FR-N03): the signed-in owner's
 * plan and a small usage summary. Bytes are integers (decimal GB in the UI). Stripe-backed fields
 * (invoices, spending cap control) arrive with T29–T32 and are not part of this contract yet.
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
});
export type AccountUsageSummary = z.infer<typeof accountUsageSummarySchema>;
