# Billing

Authoritative pricing logic lives in `packages/billing` and the versioned rate card in `packages/config/src/rate-card.ts`
(seed) / `plan_rate_versions` + `plans` tables (runtime, see "Rate card storage"). Summary of PRD §9:

- Money is integer **micro-USD** internally; Stripe amounts in cents. No floating-point money.
- Units are decimal: 1 GB = 10⁹ bytes. GB-month = byte-seconds / (10⁹ × 30 × 86,400).
- Free: 2 active galleries, 1 GB stored — hard caps, never billed.
- Pro: $2/month (confirmed); 20 GB-month included (confirmed); $0.05/GB-month storage overage (confirmed,
  rate card v2, 2026-11-16, ADR-009; v1 was $0.10);
  default $10 cap on storage overage with 50/80/100% alerts (Proposed).
- **Delivery is not tracked, capped or charged on any plan** (ADR-008): views, downloads and archives
  are free to recipients and owners. Risk: serving cost (R2 reads + Worker requests) is uncapped;
  edge caching is tracked in jasonfyw/lumra#83.
- Internal `usage_ledger` (storage only) is the real-time source of truth for caps; the Stripe meter
  receives **overage only** (MB-months above the allowance), exported daily with idempotency keys and
  reconciled (ADR-004 + 2026-11-13 amendment, T31).

Worked example (PRD §9.3): 30 GB-month stored on Pro → $2.00 + (30 − 20) × $0.05 = **$2.50**.

## Formulas (`@lumra/billing`, ADR-004)

All values come from the rate card (`RATE_CARD` = v2, `BILLING_POLICY_V1` in `@lumra/config`); none are hard-coded
in logic. Money is a safe-integer `number` of micro-USD; byte-seconds and micro-unit quantities are `bigint`.
Every rounding step is **half up** and applied once.

| Quantity                   | Formula                                                                    | Function                    |
| -------------------------- | -------------------------------------------------------------------------- | --------------------------- |
| Byte-seconds               | Σ stored bytes × duration, exact in byte-ms, then ÷ 1000                   | `integrateStorage`          |
| Micro GB-month             | byte-seconds × 10⁶ ÷ (10⁹ × 2 592 000)                                     | `storageGbMonthMicroUnits`  |
| Storage overage µ$         | max(0, µGB-month − included × 10⁶) × rate per GB-month ÷ 10⁶               | `computeOverage`            |
| Invoice                    | base fee + overage lines; cents per line = µ$ ÷ 10 000; total = Σ lines    | `rateInvoice`               |
| Admission projection       | stored-bytes reservations held until period end (ceiling); archives cost 0 | `checkAdmission`            |
| Cap tolerance              | max(cap × 10 %, $0.25)                                                     | `spendCapToleranceMicroUsd` |
| Meter value (daily, delta) | overage MB(-month) of the period-to-date total − already exported          | `buildMeterEvents`          |

Admission reason codes: `free_storage_cap`, `spend_cap`, `past_due`, `account_canceled`;
gallery creation: `free_gallery_cap`. Past-due timeline (`deriveBillingRestrictions`): uploads and new archives
stop immediately, public delivery is suspended after 7 days, and media is retained for 30 more days.

## Rate card storage (T27)

- `plan_rate_versions` holds one **immutable** row per (plan, `rate_version`). v1 is the PRD §9.2 launch rate card
  (equal to `RATE_CARD_V1`; a unit test checks the seed). v2 (migration
  `20261116000100`) differs only by Pro storage overage $0.05/GB-month (`RATE_CARD_V2` = `RATE_CARD`; also seed-checked). Its delivery columns were dropped by the
  ADR-008 migration without a version bump (no storage or base rate changed and delivery was never
  billed). Rates can never be updated or deleted (trigger,
  SQLSTATE 23001); the only allowed change is `decision` `proposed → confirmed` once the owner signs off.
- `plans.rate_version` points at the current version; a trigger copies that version's rates onto the `plans` row,
  so existing readers of `plans` (admission, `/account`, pricing) always see the current version.
- Price change = insert `rate_version = N + 1` rows, then `update plans set rate_version = N + 1` (one migration).
  Ledger rows record the version they were rated under; `PlanStore.getRates(plan, version)` reads any version.
- `BILLING_POLICY_V1` (30-day month, grace, tolerance) stays in `@lumra/config`, keyed by `rateVersion`.

### Rate card changes (v1 → v2, 2026-11-16: Pro storage overage $0.10 → $0.05)

- **Which version rates what.** The accrual job stamps each new `usage_ledger` row with `plans.rate_version`
  (the current version) and an estimate at that version's rate. Existing rows keep `rating_version = 1`
  (append-only). `getRates(plan, version)` reads any version.
- **Mid-period change.** A period that straddles the change holds v1 and v2 rows. Quantity (byte-seconds) is
  version-independent, so the period is rated as one total at the **newest** version in it
  (`max(rating_version)`: the meter export and the invoice reconciliation both do this). That equals what
  Stripe bills once the subscription item is on the v2 price (it prices the period's meter total at the price on
  the item when the invoice is created; `--migrate-subscriptions` uses `proration_behavior: none`). So the whole
  in-flight period is billed at $0.05: a price cut applies to the full period, never a blend. The per-row
  estimates of v1 rows stay at $0.10 (history, not used for billing); `/account` and the spend-cap estimate
  re-rate the period total at the current plan, so they show the v2 figure at once.
- **Periods that closed under v1** (all rows v1) reconcile at v1. Keep the gap between the migration,
  the code deploy and `--migrate-subscriptions` short (same maintenance window) so a period closing
  in between does not bill Stripe at one rate and reconcile at another (drift alert, see RUNBOOKS).
- **Spend cap.** The cap is in dollars and unchanged ($10); at half the price an account reaches it at twice the overage.

## Metering (T27)

Every metered action writes `usage_ledger` rows through `@lumra/billing` (`METERED_ACTIONS`); Postgres adapters
are in `@lumra/db` (`createBillingRepository`), the jobs in `apps/worker/src/handlers/metering.ts`.

| Metric                 | Producer                                                                            | Source id (UNIQUE with metric)  |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------- |
| `storage_byte_seconds` | Hourly cron `7 * * * *` → `planStorageAccrual`, cursor in `storage_accrual_cursors` | `account:windowStart/windowEnd` |

Storage is the only metric. The gateway emits no usage events and there is no usage queue (ADR-008).

- **Periods.** Each row is stamped with `billingPeriodAt(account, time)`: the stored subscription period when it
  contains the time, else the UTC calendar month — the same `period_start` `/account` and admission read.
- **Storage accrual** is sampled step integration: the stored bytes measured at the previous run (originals in
  `uploaded/processing/ready` + derivatives in non-deleted galleries, the `/account` definition) are held until
  this run. Error ≤ |Δbytes| × 1 hour per change, never compounding. Windows are split at period boundaries. The
  cursor moves in the same transaction as the rows, guarded by the previous `accrued_through`, so overlapping or
  retried runs never double-count. An account's first run only creates the cursor (no back-billing before the job
  existed). Temporary archives (T24) count too: completed parts of `running`/`ready` jobs of the owner's
  non-deleted galleries, until they expire (24 h). `/account` still shows originals + derivatives only.
- **Estimated cost** per row is the marginal overage it adds to the period total so far (0 on Free and inside the
  Pro allowance); the invoice is still rated from period totals (`rateInvoice`), and the two agree.
- **Reservations.** `CostReservationStore.pending` returns live upload intents (original + derivative estimate)
  for admission. Archives reserve nothing: their downloads are not billed. The web app's admission
  (`apps/web/src/server/admission.ts`, shared by upload intents and archive requests) gates archive requests by
  billing status only.

## Account page (`/account`, `GET /api/v1/billing/usage`)

Read-only summary for the signed-in owner (FR-N03), built by `getAccountUsageSummary`
(`apps/web/src/server/account.ts`) with the rules in `@lumra/billing` (`currentBillingPeriod`, `summarizeUsage`):

- **Plan / status:** `profiles.plan_id` and `billing_accounts.status` (both created by `handle_new_user`).
- **Period:** `billing_accounts.billing_period_start/end`, else the UTC calendar month (same rule as admission).
- **Storage:** bytes of stored originals (`uploaded`/`processing`/`ready`) plus generated derivatives in the owner's
  non-deleted galleries — the dashboard's per-gallery size summed. Free shows it against the 1 GB hard cap
  (admission additionally reserves an estimate for not-yet-generated derivatives).
- **Billing:** plan actions (Upgrade → Checkout, Manage billing → Portal), state banners (below) and the
  galleries count. Buttons are disabled with a reason when Stripe is not configured.
- **Invoices:** the last 12 webhook-stored invoices (`billing_invoices`) with Stripe's hosted page,
  plus "All invoices and receipts" (portal).
- **Spending cap and alerts (Pro):** cap control, estimated overage vs cap, alerts sent this period.

A dev-only fixture renders every billing state without Stripe or a database: `/dev/account?state=…`
(`free`, `free_at_caps`, `checkout_pending`, `pro`, `pro_canceling`, `pro_alert_80`, `pro_spend_cap`,
`past_due`, `restricted`, `canceled`, `unconfigured`).

## Free caps (T28)

| Cap                             | Where it is enforced                                                                | What the user sees                                           |
| ------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 2 active galleries              | `POST /api/v1/galleries` and the guest claim (`checkGalleryCreation`, profile lock) | `quota_exceeded` + "See plans"                               |
| 1 GB stored (incl. derivatives) | upload intents (`checkAdmission`, account row lock, derivative estimate)            | uploader banner "Your Free storage is full" → Upgrade to Pro |

There is no delivery cap: shared galleries, views and downloads are never paused for usage (ADR-008).
Free storage rows always carry zero cost (property test: a Free account can never create a
positive-overage ledger row). Galleries go offline only for billing status (`deliverySuspended` in
KV = past due beyond grace, restricted or canceled): the gateway answers 403 `gallery_suspended` and
the recipient page renders "This gallery is temporarily unavailable" (`gallery_unavailable`, 503).

## Subscriptions and entitlements (T29, T30)

- **Checkout** (`POST /api/v1/billing/checkout`, auth + same-origin + per-user rate limit): creates the
  Stripe customer on first use (idempotency key `lumra-customer-{userId}`, stored by compare-and-set)
  and a subscription-mode Checkout Session with **two line items**: the $2 base price (quantity 1)
  and the metered storage overage price (no quantity). No delivery price (ADR-008). Prices are
  found by lookup key
  (`STRIPE_CATALOG`, cached 10 min). 409 when a live subscription exists.
- **Portal** (`POST /api/v1/billing/portal`): Billing Portal session for the owner's own customer,
  using the configuration tagged `metadata.lumra_config=lumra_portal_v1` (fallback: account default).
  409 without a customer.
- **Webhook** (`POST /api/v1/billing/webhook`, Node runtime): signature verified over the raw body
  (`request.text()`) with `STRIPE_WEBHOOK_SECRET`; bad/missing signature → 422, unconfigured → 503.
  Each event runs in one transaction: claim `provider_webhook_events (provider, provider_event_id)` →
  apply → mark `processed`/`ignored`. A replay (or a concurrent duplicate) finds the row handled and is
  a no-op (G-06). A failure rolls everything back, answers 500 (Stripe retries) and records the
  attempt as `failed` with the error class only. Payloads are not stored.
- **Entitlements come only from `customer.subscription.*`** (`applySubscriptionSnapshot`):

  | Stripe status                    | Billing status                              | Plan |
  | -------------------------------- | ------------------------------------------- | ---- |
  | `active`, `trialing`             | `active`                                    | pro  |
  | `past_due`, `unpaid`             | `past_due` (grace clock keeps running)      | pro  |
  | `paused`                         | `restricted`                                | pro  |
  | `canceled`, `incomplete_expired` | `free` if within Free caps, else `canceled` | free |
  | `incomplete`                     | no change                                   | —    |

  Events older than the last applied one (`subscription_event_at`) are ignored; an old subscription
  ending never touches a newer one. The plan switch updates `profiles.plan_id`, which drives limits and
  branding (Pro hides "Made with Lumra"); status/plan changes re-sync KV for every published gallery and
  enqueue the transition notice (`pro_activated`, `payment_failed`, `payment_recovered`,
  `delivery_suspended`, `subscription_ended`; dedupe key per event). The Pro billing period comes from
  the subscription items; `checkout.session.completed` only links the customer. The success redirect
  (`/account?checkout=success`) changes wording only.

- **Canceled over Free caps**: uploads, archives and public delivery stop; media is kept 30 days from
  `canceled_at`. The hourly sweep moves the account to `free` as soon as it fits the Free caps (owner
  deleted galleries/photos); subscribing again restores Pro.

## Payment failures (T33)

`deriveBillingRestrictions` is the rule; persisted transitions follow it:

| State                                          | Uploads / new archives | Public delivery                            | Media                         |
| ---------------------------------------------- | ---------------------- | ------------------------------------------ | ----------------------------- |
| `past_due` (webhook)                           | stopped immediately    | continues for 7 days (`past_due_since`)    | kept                          |
| `restricted` (sweep at grace end, or `paused`) | stopped                | suspended (`restricted_since` = grace end) | kept 30 days after suspension |
| `active` again (payment)                       | resumed                | resumed                                    | —                             |

The hourly sweep (`7 * * * *`, after storage accrual) persists `past_due → restricted` stamped at the
grace end (not the sweep time), re-syncs KV and enqueues `delivery_suspended`. Nothing deletes data:
retention end is shown on `/account`, and deletion requires an explicit policy + notice (PRD §9.4).

## Notifications (`email.send`)

Transition notices (and T32 alerts) are `email.send` outbox events (`public.enqueue_account_email`,
once-only by dedupe key) carrying the account id, a template name and small non-personal `data` (no
address). The worker (`apps/worker/src/handlers/email.ts`) renders the template, reads
`profiles.email` by `accountId` at send time and posts to Resend
(`POST https://api.resend.com/emails`) with the outbox `dedupeKey` as `Idempotency-Key`, so a
redelivery never sends twice (Resend keeps keys for 24 h).

| Template             | Subject                                      | When                                |
| -------------------- | -------------------------------------------- | ----------------------------------- |
| `pro_activated`      | Welcome to Lumra Pro                         | Pro entitlement starts              |
| `payment_failed`     | Action needed: your Lumra payment failed     | `past_due`                          |
| `payment_recovered`  | Your Lumra payment went through              | back to `active`                    |
| `delivery_suspended` | Your Lumra galleries are paused              | sweep: `past_due` to `restricted`   |
| `subscription_ended` | Your Lumra Pro plan has ended                | `canceled` to `free`                |
| `spend_cap_alert`    | Lumra usage alert: 50% / 80% / reached (100) | storage overage hits cap thresholds |

Templates are plain TS strings (`apps/worker/src/email/layout.ts`, `templates.ts`): one shared
branded layout (table, inline styles, no remote assets), an HTML and a plain-text part. Same visual
style as the Supabase auth emails.

- **Config (worker):** secret `RESEND_API_KEY` (`wrangler secret put RESEND_API_KEY --env
production`), optional vars `EMAIL_FROM` (default `Lumra <hello@lumra.photos>`), `EMAIL_REPLY_TO`
  (default none) and `APP_URL` (default `https://www.lumra.photos`, used for links).
- **Unset `RESEND_API_KEY`:** the message is logged (`email not sent: RESEND_API_KEY not set`) and
  acked; nothing crashes. In-app banners on `/account` and the dashboard show the same states.
- **Failures:** 429, 5xx, network errors and a concurrent idempotent request (409) throw, so the
  queue retries with back-off (`retryDelaySeconds`, `max_retries` then the DLQ). Other 4xx
  (validation, revoked key, unverified domain) are logged as `email rejected by provider; not
retrying` and acked. An account with no address is logged and acked.
- **Privacy:** logs hold the template, account id and Resend status only: never the address, the
  API key or the body.

## Stripe setup (`scripts/stripe-setup.mjs`)

Idempotent, dependency-free; runs in the mode of the key it is given and prints object ids only:

```sh
STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs --dry-run      # report only
STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs --app-url https://www.lumra.photos
STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-setup.mjs --archive-legacy  # only retire delivery objects
```

It ensures the "Lumra Pro" product, the base price `lumra_pro_monthly_v1` ($2/month), the meter
`lumra_storage_overage` (sum, `stripe_customer_id` → customer, `value`), the metered price
`lumra_pro_storage_overage_v2` (0.005¢ per MB-month = $0.05/GB-month), and the Billing Portal configuration
(payment method, invoices, cancel at period end, email/address). It also retires the removed delivery
charge (ADR-008) and the superseded $0.10 storage price (idempotent): archives the prices
`lumra_pro_delivery_overage_v1` and `lumra_pro_storage_overage_v1`, deactivates the meter
`lumra_delivery_overage`, and lists (never modifies) subscriptions that still carry a retired price.
Existing objects are reused; a price with different terms is an error (ship `_vN` lookup keys with
a new rate version). A unit test checks the script against `STRIPE_CATALOG` and `RATE_CARD`.

`--migrate-subscriptions` (own step; supports `--dry-run`) moves every active/trialing/past_due
subscription whose storage item is on the v1 price to `lumra_pro_storage_overage_v2` with
`proration_behavior: none` (metered items). Idempotent, prints subscription ids only. Run per mode
(test, then live) after the setup run created the v2 price. Canceled subscriptions keep the archived
v1 price (nothing more to bill).

## Usage export to Stripe (T31)

- **What is sent:** storage overage only, as integer MB-months above the plan
  allowance (`toMeterUnits`), cumulative per period: each run sends `period-to-date units − already
exported`, so rounding never accumulates and re-runs send nothing new.
- **Which usage:** only periods in `billing_periods` — the paid subscription periods recorded by the
  webhook. Free (calendar-month) usage can never reach a meter, even after a mid-month upgrade.
- **When:** daily at 03:17 UTC (`METER_EXPORT_CRON`) for every period that ended < 35 days ago (Stripe's
  limit), and hourly (after storage accrual) for periods that closed in the last 3 hours, so the final
  usage lands while Stripe's invoice is still a draft. Timestamps are clamped to one second before the
  period end.
- **How:** `recordExport` stores the events (`billing_exports`, `idempotency_key` = Stripe
  `identifier` = `account:metric:periodStart:windowEnd`) and moves `billing_meter_cursors` by
  compare-and-set in one transaction; then every unsent stored event is POSTed to
  `/v1/billing/meter_events` with `Idempotency-Key` = identifier and the pinned API version. Retries
  resend the stored payload byte for byte. 4xx (except 429) are parked (`failed`, beyond the 20-attempt
  budget); 5xx/429/network retry on the next run. AC: re-running the export produces no duplicate
  meter events (worker test + DB test).
- **Config:** worker secret `STRIPE_SECRET_KEY` (`wrangler secret put STRIPE_SECRET_KEY --env
production`); unset ⇒ the export is skipped and logged, nothing is built.

## Invoices and reconciliation (T31)

`invoice.finalized|paid|payment_failed|voided|marked_uncollectible` upsert `billing_invoices` (newer
`event.created` wins; hosted URLs stored only if `https://`, never logged). On `invoice.finalized` the
invoice is reconciled (`reconcileInvoice`): expected = base fee + internal overage of the period that
starts at the invoice's `period_start` (renewal invoices bill the ended period's usage; the first
invoice is the base fee only) vs Stripe's `subtotal`. A row goes to `billing_reconciliations`; drift
above 10 % (and more than 2 ¢) or overage above cap + tolerance logs `billing reconciliation mismatch`
(error → Sentry/log alert). Discounts/credits applied as invoice items would show as drift.

## Spending cap and alerts (T32)

- `PATCH /api/v1/billing/spending-cap` `{capMicroUsd}`: whole cents from $0 to
  `BILLING_POLICY_V1.maxSpendCapMicroUsd` ($500, Proposed), or `null` for the plan default ($10). Pro
  only (409 on Free), same-origin, per-user rate limit, own account only. Alerts are re-evaluated at
  once. The cap covers **storage overage only** (ADR-008).
- **Admission denial at cap:** upload intents use `checkAdmission` with the account's cap, projecting
  stored bytes to the period end (`spend_cap_reached` → uploader banner "Adjust spending cap"). Archive
  requests are never refused for the cap. Shared galleries are never paused for usage.
- **Alerts:** in the hourly sweep (after storage accrual) and after cap/plan changes,
  `evaluateBillingSafeguards` computes the estimated storage overage and records each reached threshold
  of `warning_thresholds` (50/80/100 %) once per (account, period, threshold) in `billing_alerts`,
  enqueuing one `spend_cap_alert` email each. `/account` and the dashboard show a banner for the
  highest threshold reached.
- Tolerance: the derivative-size estimate and hourly accrual can overshoot slightly; the disclosed
  maximum is max(10 % of cap, $0.25) and reconciliation flags periods beyond it.

## Environment and webhook endpoint

| Variable                                  | Where           | Notes                                                                              |
| ----------------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                       | Vercel (server) | `sk_…`/`rk_…`; unset ⇒ billing disabled gracefully. Test key outside prod.         |
| `STRIPE_WEBHOOK_SECRET`                   | Vercel (server) | Endpoint signing secret `whsec_…` for `/api/v1/billing/webhook`.                   |
| `STRIPE_SECRET_KEY`                       | Worker (secret) | Same key; daily meter export. Unset ⇒ export skipped (logged).                     |
| `RESEND_API_KEY`                          | Worker (secret) | Resend key (sending access). Unset ⇒ app email logged and acked, not sent.         |
| `EMAIL_FROM`, `EMAIL_REPLY_TO`, `APP_URL` | Worker (vars)   | Optional; defaults `Lumra <hello@lumra.photos>`, none, `https://www.lumra.photos`. |

Webhook endpoint: `https://www.lumra.photos/api/v1/billing/webhook` (the PRD's `/api/v1/webhooks/stripe`
path sits with the other billing routes instead; ADR-004 amendment). Subscribe it to
`checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`,
`invoice.voided` and `invoice.marked_uncollectible`.
