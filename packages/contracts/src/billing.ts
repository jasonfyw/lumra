import { z } from 'zod';

/**
 * Stripe-backed billing endpoints (PRD §10, T29). Both return a hosted Stripe URL that the browser
 * navigates to; entitlements change only when the signed webhook confirms the subscription.
 *
 * - `POST /api/v1/billing/checkout` → Checkout Session (subscription: Pro base + metered prices)
 * - `POST /api/v1/billing/portal`   → Billing Portal session (payment method, invoices, cancel)
 */
export const billingRedirectResponseSchema = z.object({ url: z.url() });
export type BillingRedirectResponse = z.infer<typeof billingRedirectResponseSchema>;

/** Both endpoints take an empty JSON body (`{}`); unknown keys are rejected. */
export const billingRedirectRequestSchema = z.object({}).strict();

/**
 * `PATCH /api/v1/billing/spending-cap` (T32, PRD §10 "split PATCH endpoint"). Integer micro-USD in
 * whole cents from $0 to the platform maximum (`BILLING_POLICY_V1.maxSpendCapMicroUsd`, checked
 * server-side); `null` returns to the plan default.
 */
export const spendingCapRequestSchema = z
  .object({ capMicroUsd: z.number().int().nonnegative().nullable() })
  .strict();
export type SpendingCapRequest = z.infer<typeof spendingCapRequestSchema>;
