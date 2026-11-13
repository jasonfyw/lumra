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
