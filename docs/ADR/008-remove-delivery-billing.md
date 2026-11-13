# 008. Remove delivery from pricing

Status: Accepted · Date: 2026-11-13 · Task: T27–T33 (pricing change)

## Context

Rate card v1 (PRD §9.2 before this change, ADR-004) priced **delivery**: Free had a 3 GB/month delivery
hard cap, Pro included 5 GB/month and charged $0.03/GB above it, and the spending cap paused public
delivery when reached. That required the media gateway to emit a `delivery.served` event per response, a
`lumra-usage` queue and worker consumer, `delivery_bytes` ledger rows, a delivery cutoff persisted on
`billing_accounts.delivery_paused_*` and mirrored into KV, a second Stripe meter and price, and a
"bandwidth-limit" experience for viewers.

The product owner decided (2026-11-13) to **remove delivery from Lumra's pricing entirely**: it is no
longer tracked, capped or charged on any plan. This is a PRD change (CLAUDE.md "don't add scope not in
the PRD"), so the PRD is amended together with this ADR.

## Decision

Pricing becomes:

|                                       | Free                     | Pro                                       |
| ------------------------------------- | ------------------------ | ----------------------------------------- |
| Base                                  | $0                       | $2.00/month                               |
| Galleries                             | 2 active                 | unlimited (fair use)                      |
| Storage                               | 1 GB hard cap            | 20 GB-month included, then $0.10/GB-month |
| Spending cap                          | n/a                      | $10 default, **storage overage only**     |
| Delivery (views, downloads, archives) | not metered, not charged | not metered, not charged                  |

PRD §9.3 worked example: `$2.00 + (30 − 20) × $0.10 = $3.00`.

Removed everywhere: the `delivery.served` contract, the gateway's `USAGE` producer, the worker's
`lumra-usage*` consumer and delivery ingestion (`rateDeliveryEvents`), `delivery_bytes` ledger rows and
the enum value, delivery rate-card columns, the delivery cutoff (`checkDeliveryAllowance`,
`delivery_paused_*`, `delivery_paused` email), delivery reservations for archives, the delivery meter
export, the `/account` delivery row and banners, pricing copy, and the Stripe delivery meter/price.

Kept: `deliverySuspended` in the KV access state and `publicDeliveryAllowed` — they now mean only
**billing suspension** (past due beyond the grace, restricted, canceled), which still denies at the
gateway and shows "temporarily unavailable" on the recipient page (PRD §9.4).

The spending cap applies to storage overage only. Upload admission already projects stored bytes to the
end of the period, so it is the single enforcement point; archive requests add no billable cost and are
gated only by billing status. The hourly sweep still records 50/80/100 % alerts.

**Rate version.** No new rate version is created: the base fee and storage rates are unchanged and no
delivery usage was ever billed, so storage usage rated under v1 stays reproducible. The migration
(`20261113000300_remove_delivery_billing.sql`) drops the delivery columns from `plans` and
`plan_rate_versions` after redefining the immutability guard and the projection trigger without them,
deletes the never-billed `delivery_bytes` ledger rows through a temporary, flag-gated bypass of the
append-only guard, deletes delivery meter cursors, retires unsent delivery meter exports (kept for audit
with `metric` cleared), recreates `usage_metric` without `delivery_bytes`, re-syncs the KV state of any
paused account and drops queued `delivery_paused` emails. Forward-only; the rollback note is in the
migration header.

**Stripe.** `scripts/stripe-setup.mjs` no longer creates the delivery meter/price; Checkout carries only
the base and storage prices. The script archives `lumra_pro_delivery_overage_v1` and deactivates the
`lumra_delivery_overage` meter idempotently (also alone with `--archive-legacy`). Existing subscriptions
that still carry the delivery price are listed, never modified: no meter events reach it, so the line
stays $0.

## Consequences

- **Risk: uncapped serving cost.** Every view and download still costs Lumra R2 Class B reads and
  Worker requests (R2 egress itself is free). With no delivery meter or cutoff, a viral or scraped
  gallery has no per-account cost ceiling and no revenue offsetting it. Mitigations: existing anonymous
  rate limits and view throttles (PRD §11), the ≤ 5 min token TTL, and **edge caching of previews,
  tracked in jasonfyw/lumra#83**. Operators should watch R2 Class B operations and gateway request
  volume (RUNBOOKS) until #83 lands.
- Simpler system: one queue, one consumer, one meter, one Stripe metered price; the gateway does no
  background work per response.
- Hosted leftovers (queues `lumra-usage`, `lumra-usage-dlq`, `lumra-usage-dev`, `lumra-usage-dlq-dev`,
  `lumra-usage-staging`) are unbound and can be deleted by the owner.
- Regression tests: the rate card, ledger enum, contracts, Stripe catalog, wrangler configs, gateway and
  pricing page each assert that no delivery metering, cap or price remains.

## Alternatives considered

- **Keep metering, stop charging** (delivery visible on `/account`, no cutoff). Rejected by the owner:
  delivery is not tracked at all, and keeping the queue/consumer costs Worker invocations for nothing.
- **New rate version v2 without delivery.** Rejected: identical storage and base rates, so a version
  bump would add Stripe `_v2` keys and price churn without changing any rated amount.
- **Keep a delivery safety cutoff for abuse only.** Deferred to #83 (edge caching) and rate limits; a
  usage-based cutoff would reintroduce the metering this decision removes.
