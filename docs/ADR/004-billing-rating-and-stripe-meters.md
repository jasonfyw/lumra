# 004. Billing rating, rounding and Stripe meter mapping

Status: Accepted · Date: 2026-11-05 · Task: T27

## Context

Pro is a confirmed $2/month base fee plus metered storage (GB-month) and delivery (GB) overages; Free has
hard caps and must never be billed (PRD §9). Usage readings lag, Stripe meter events are asynchronous, and the
spending cap must be enforced in real time (§9.4–9.5). Money must never touch floating point. The commercial
values in `RATE_CARD_V1` / `BILLING_POLICY_V1` are still **Proposed** (PRD §17, PLAN §5 #4), so logic must read
them from the rate card and never hard-code them.

## Decision

**Internal ledger is authoritative.** `usage_ledger` is append-only, with one row per metered fact and a
deterministic idempotency key `metric:source_id` backing `UNIQUE (metric, source_id)`. Metrics:
`storage_byte_seconds` (unit `byte_second`; source id = account + non-overlapping integration window) and
`delivery_bytes` (unit `byte`; source id = gateway delivery event id). The `quantity_micro_units` column holds
the exact integer quantity in the row's unit, so ingestion never rounds. Spending caps, alerts and admission
read only the ledger plus pending reservations. Stripe aggregates are never a cap oracle.

**Integer representation.** Money is micro-USD as a JS `number`, asserted `Number.isSafeInteger` (the limit is
about $9 billion). Byte-seconds and micro-unit quantities are `bigint`, because 1 TB held for a month is
2.6 × 10¹⁸ byte-seconds, which is more than 2⁵³. Every intermediate product is computed in `bigint`.

**Units.** Decimal GB = 10⁹ bytes. GB-month = byte-seconds / (10⁹ × `secondsPerBillingMonth`), where v1 uses
30 × 86 400 for every period, whatever the calendar length (disclosed). Storage is integrated exactly in
byte-milliseconds and converted to byte-seconds once.

**Rounding: half up, applied once per quantity, never compounded.**

| Step                                  | Rule                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| byte-ms → byte-seconds                | half up, once per integration window                         |
| byte-seconds → micro GB-month         | half up, on the period total (rating) or cumulative (export) |
| overage line → micro-USD              | `quantity × rate / unit`, half up, per line                  |
| line micro-USD → cents (Stripe minor) | half up, per line; invoice cents = Σ line cents              |
| admission projections                 | ceiling (conservative upper bound)                           |

We chose half up rather than banker's rounding because it is the rule customers and tax tools expect, and
because inputs are never negative. Banker's rounding only removes bias when you sum many independently rounded
values. Our design avoids that case: each quantity is rounded once, on a period or cumulative total, so the
worst error is 0.5 micro-unit per line (≤ $0.0000005), far below a cent.

**Stripe mapping.** Two Billing Meters, with integer values in micro-units:

- `lumra_storage_gb_month_micro`: micro GB-months. The price is graduated: the first 2 × 10⁶ units free,
  then $0.10 / 10⁶ per unit.
- `lumra_delivery_gb_micro`: micro GB (decimal kB). The price has the first 5 × 10⁶ units free, then
  $0.03 / 10⁶ per unit.

The prices mirror the rate-card version; a rate change creates new Stripe prices and a new `rateVersion`.

**Daily export is cumulative.** Each run (`buildMeterEvents`) converts the period-to-date ledger total to meter
units once and sends only the difference from the stored cursor. The sum of all deltas therefore equals the
rounded period total, so daily rounding cannot drift. Each event's `identifier` (also used as the request
`Idempotency-Key`) is `account:metric:periodStartUnix:windowEndUnix`, and its `timestamp` is the window end.
Replays are byte-identical. T31 must persist the built events and new cursors in `billing_exports` _before_
sending, and resend the stored payload on retry. It must never recompute, because a late ledger row would
otherwise change the body behind a reused identifier.

**Spending cap and tolerance.**

- Admission (`checkAdmission`) is strict and reservation-based. It assumes that current, pending and requested
  upload bytes stay stored until the period ends, and that pending and requested archives are fully delivered.
  It denies when the projected overage exceeds the cap.
- The delivery safety cutoff (`checkDeliveryAllowance`) pauses new billable delivery once the estimated overage
  reaches the cap. For Free, it pauses at the 3 GB monthly delivery cap.
- Transfers already in flight and metering lag can overshoot. The disclosed maximum tolerance is
  max(10 % of cap, $0.25) (Proposed, `BILLING_POLICY_V1`). Reconciliation flags any period that exceeds
  cap + tolerance (`exceedsCapTolerance`) for an operator credit. We do not promise a perfect hard stop.
- Alerts fire at 50/80/100 % of the cap. `alertThresholdsCrossed` returns only the newly crossed thresholds,
  and they are deduped by (account, period, threshold).

**Billing account state.** The transition table lives in `@lumra/billing` and reuses `TransitionTable` from
`@lumra/domain`: `free → active → past_due → restricted`, `active/past_due/restricted → canceled`,
`past_due/restricted → active`, and `canceled → active | free`.

The time-based consequences come from `deriveBillingRestrictions(account, now)` rather than a cron job:

- `past_due` stops uploads and new archives immediately.
- After 7 days, public delivery is suspended.
- Media is then preserved for 30 more days.

These durations are Proposed. Nothing in this package deletes data.

## Consequences

- Rating, estimation and invoices share one code path (`computeOverage`), so the estimate shown before an
  upload equals the invoice's overage lines.
- Stripe invoices can differ from internal invoices by at most one cent per line, because Stripe rounds the
  graduated tier total. T31 reconciliation alerts on larger drift (PLAN: >10 %).
- The `plans` table must store every `PlanRates` field plus `rateVersion`. The PRD lists `monthly_fee_cents`;
  we keep micro-USD internally and derive cents.
- In-flight upload reservations must include an estimate of derivative bytes, because the Free 1 GB cap counts
  originals and derivatives.

## Alternatives considered

- **Stripe as the source of truth for usage.** Rejected. Meter aggregation is asynchronous and cannot enforce
  caps in real time (§9.5).
- **Per-event meter export.** Rejected. It means millions of tiny events, Stripe rate limits, and a rounding
  step on every event.
- **Banker's rounding.** Rejected. See above: there are no repeated rounded sums to de-bias.
- **Floating-point GB values in meters.** Rejected. Integer micro-units are exact, and Stripe prices accept
  decimal unit amounts.
- **Invoice items instead of meters.** These remain a fallback if Billing Meters prove unsuitable. The ledger
  and cumulative-delta design is unchanged either way.
