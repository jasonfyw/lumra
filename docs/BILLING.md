# Billing

Authoritative pricing logic lives in `packages/billing` and the versioned rate card in `packages/config/src/rate-card.ts`
(seed) / `plan_rate_versions` + `plans` tables (runtime, see "Rate card storage"). Summary of PRD §9:

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

## Rate card storage (T27)

- `plan_rate_versions` holds one **immutable** row per (plan, `rate_version`). v1 is the PRD §9.2 launch rate card
  (equal to `RATE_CARD_V1`; a unit test checks the seed). Rates can never be updated or deleted (trigger,
  SQLSTATE 23001); the only allowed change is `decision` `proposed → confirmed` once the owner signs off.
- `plans.rate_version` points at the current version; a trigger copies that version's rates onto the `plans` row,
  so existing readers of `plans` (admission, `/account`, pricing) always see the current version.
- Price change = insert `rate_version = N + 1` rows, then `update plans set rate_version = N + 1` (one migration).
  Ledger rows record the version they were rated under; `PlanStore.getRates(plan, version)` reads any version.
- `BILLING_POLICY_V1` (30-day month, grace, tolerance) stays in `@lumra/config`, keyed by `rateVersion`.

## Metering (T27)

Every metered action writes `usage_ledger` rows through `@lumra/billing` (`METERED_ACTIONS`); Postgres adapters
are in `@lumra/db` (`createBillingRepository`), the jobs in `apps/worker/src/handlers/metering.ts`.

| Metric                 | Producer                                                                            | Source id (UNIQUE with metric)        |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------- |
| `storage_byte_seconds` | Hourly cron `7 * * * *` → `planStorageAccrual`, cursor in `storage_accrual_cursors` | `account:windowStart/windowEnd`       |
| `delivery_bytes`       | `lumra-usage*` queue (`delivery.served` from the gateway) → `rateDeliveryEvents`    | gateway `dedupeKey` = `jti:start-end` |

- **Periods.** Each row is stamped with `billingPeriodAt(account, time)`: the stored subscription period when it
  contains the time, else the UTC calendar month — the same `period_start` `/account` and admission read.
- **Storage accrual** is sampled step integration: the stored bytes measured at the previous run (originals in
  `uploaded/processing/ready` + derivatives in non-deleted galleries, the `/account` definition) are held until
  this run. Error ≤ |Δbytes| × 1 hour per change, never compounding. Windows are split at period boundaries. The
  cursor moves in the same transaction as the rows, guarded by the previous `accrued_through`, so overlapping or
  retried runs never double-count. An account's first run only creates the cursor (no back-billing before the job
  existed). Archives (T24) are not counted yet.
- **Delivery ingestion** resolves gallery → owner, rates the batch and inserts it with one
  `INSERT … ON CONFLICT DO NOTHING`. Redelivered events are dropped by the UNIQUE key; distinct tokens or ranges
  count separately. Approximation (disclosed): one token re-downloading the _same_ byte range is counted once.
  Guest-draft galleries (no owner) and deleted gallery rows are skipped and counted in the batch log.
- **Estimated cost** per row is the marginal overage it adds to the period total so far (0 on Free and inside the
  Pro allowance); the invoice is still rated from period totals (`rateInvoice`), and the two agree.
- **Reservations.** `CostReservationStore.pending` returns live upload intents (original + derivative estimate)
  and archives being built (estimated as the gallery's ready originals) for admission.

## Account page (`/account`, `GET /api/v1/billing/usage`)

Read-only summary for the signed-in owner (FR-N03), built by `getAccountUsageSummary`
(`apps/web/src/server/account.ts`) with the rules in `@lumra/billing` (`currentBillingPeriod`, `summarizeUsage`):

- **Plan / status:** `profiles.plan_id` and `billing_accounts.status` (both created by `handle_new_user`).
- **Period:** `billing_accounts.billing_period_start/end`, else the UTC calendar month (same rule as admission).
- **Storage:** bytes of stored originals (`uploaded`/`processing`/`ready`) plus generated derivatives in the owner's
  non-deleted galleries — the dashboard's per-gallery size summed. Free shows it against the 1 GB hard cap
  (admission additionally reserves an estimate for not-yet-generated derivatives).
- **Delivery:** `usage_ledger` `delivery_bytes` for the current period. Shown as "Not yet tracked" until the ledger
  holds any delivery row for the account (filled by the T27 delivery ingestion once the usage consumer is deployed).
- **Invoices, spending cap and alerts:** rendered disabled ("available when paid plans launch") until T29–T32.
