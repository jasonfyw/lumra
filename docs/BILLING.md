# Billing

Authoritative pricing logic lives in `packages/billing` and the versioned rate card in `packages/config/src/rate-card.ts`
(seed) / `plans` table (runtime). Summary of PRD §9:

- Money is integer **micro-USD** internally; Stripe amounts in cents. No floating-point money.
- Units are decimal: 1 GB = 10⁹ bytes. GB-month = byte-seconds / (10⁹ × 30 × 86,400).
- Free: 2 galleries, 1 GB stored, 3 GB/month delivery — hard caps, never billed.
- Pro: $2/month (confirmed); 2 GB-month + 5 GB delivery included; $0.10/GB-month and $0.03/GB overages (Proposed);
  default $10 overage cap with 50/80/100% alerts (Proposed).
- Internal `usage_ledger` is the real-time source of truth for caps; Stripe meters are exported daily with
  idempotency keys and reconciled (ADR-004, T31).

Worked example (PRD §9.3): 12 GB-month stored + 45 GB delivered on Pro → $2.00 + 10 × $0.10 + 40 × $0.03 = **$4.20**.

## Formulas (`@lumra/billing`, ADR-004)

All values come from the rate card (`RATE_CARD_V1`, `BILLING_POLICY_V1` in `@lumra/config`); none are hard-coded
in logic. Money is a safe-integer `number` of micro-USD; byte-seconds and micro-unit quantities are `bigint`.
Every rounding step is **half up** and applied once.

| Quantity                   | Formula                                                                       | Function                    |
| -------------------------- | ----------------------------------------------------------------------------- | --------------------------- |
| Byte-seconds               | Σ stored bytes × duration, exact in byte-ms, then ÷ 1000                      | `integrateStorage`          |
| Micro GB-month             | byte-seconds × 10⁶ ÷ (10⁹ × 2 592 000)                                        | `storageGbMonthMicroUnits`  |
| Storage overage µ$         | max(0, µGB-month − included × 10⁶) × rate per GB-month ÷ 10⁶                  | `computeOverage`            |
| Delivery overage µ$        | max(0, bytes − included × 10⁹) × rate per GB ÷ 10⁹                            | `computeOverage`            |
| Invoice                    | base fee + overage lines; cents per line = µ$ ÷ 10 000; total = Σ lines       | `rateInvoice`               |
| Admission projection       | stored-bytes reservations held until period end (ceiling); archives delivered | `checkAdmission`            |
| Cap tolerance              | max(cap × 10 %, $0.25)                                                        | `spendCapToleranceMicroUsd` |
| Meter value (daily, delta) | toMeterUnits(period-to-date ledger total) − already exported                  | `buildMeterEvents`          |

Admission reason codes: `free_storage_cap`, `free_delivery_cap`, `spend_cap`, `past_due`, `account_canceled`;
gallery creation: `free_gallery_cap`. Past-due timeline (`deriveBillingRestrictions`): uploads and new archives
stop immediately, public delivery is suspended after 7 days, and media is retained for 30 more days.

## Account page (`/account`, `GET /api/v1/billing/usage`)

Read-only summary for the signed-in owner (FR-N03), built by `getAccountUsageSummary`
(`apps/web/src/server/account.ts`) with the rules in `@lumra/billing` (`currentBillingPeriod`, `summarizeUsage`):

- **Plan / status:** `profiles.plan_id` and `billing_accounts.status` (both created by `handle_new_user`).
- **Period:** `billing_accounts.billing_period_start/end`, else the UTC calendar month (same rule as admission).
- **Storage:** bytes of stored originals (`uploaded`/`processing`/`ready`) plus generated derivatives in the owner's
  non-deleted galleries — the dashboard's per-gallery size summed. Free shows it against the 1 GB hard cap
  (admission additionally reserves an estimate for not-yet-generated derivatives).
- **Delivery:** `usage_ledger` `delivery_bytes` for the current period. Shown as "Not yet tracked" until the ledger
  holds any delivery row for the account (gateway metering lands with T27).
- **Invoices, spending cap and alerts:** rendered disabled ("available when paid plans launch") until T29–T32.
