# 009. Pro storage overage $0.05 per GB-month (rate card v2)

Status: Accepted · Date: 2026-11-16 · Task: T27–T31 (pricing change)

## Context

Rate card v1 (PRD §9.2, ADR-004, ADR-008) charged Pro $0.10 per GB-month of storage above the 20 GB-month
allowance. The product owner decided on 2026-11-16 to lower that overage to **$0.05 per GB-month** and
confirmed the Pro storage price and the 20 GB-month allowance. Everything else is unchanged: Free = 2
active galleries + 1 GB hard cap, Pro = $2/month, $10 default spending cap, delivery not billed (ADR-008).

## Decision

- New rate version **v2** for `free` and `pro` in `plan_rate_versions` (rows are immutable by trigger, so
  a price change is a new version); `plans.rate_version` is repointed to 2. Pro v2 is
  `decision = 'confirmed'`; its notes list what is confirmed and what stays Proposed (the $10 default
  cap). The Free v2 row stays `proposed` (gallery count and 1 GB cap). `decision` is per row, not per value.
- Code: `RATE_CARD_V2` (= `RATE_CARD`, the current card) in `@lumra/config`; `RATE_CARD_V1` stays for
  reproducing old periods. A schema test checks both seeds against the migrations.
- Stripe prices are immutable: new metered price `lumra_pro_storage_overage_v2` (0.005 ¢ per MB-month) on the
  same meter `lumra_storage_overage`; `…_v1` is archived. Checkout resolves the v2 lookup key.
  `scripts/stripe-setup.mjs --migrate-subscriptions` moves live subscriptions' storage item to v2 with
  `proration_behavior: none`.
- **Mid-period behaviour.** Ledger rows keep the version they were written under (append-only). A period
  holding both versions is rated as one total at the newest version, which equals what Stripe bills
  (it prices the period's meter total at the price on the subscription item when invoicing). The whole
  in-flight period therefore bills at $0.05; the change never produces a blend and never raises a bill.
  Details: `docs/BILLING.md` "Rate card changes".

PRD §9.3 worked example: `$2.00 + (30 − 20) × $0.05 = $2.50`.

## Consequences

- The default $10 cap now covers 200 GB-month of overage instead of 100.
- A short window between migration, deploy and subscription migration can show a one-off
  reconciliation drift (RUNBOOKS); keep them in one maintenance window.
- Unit economics must be re-validated at $0.05 against R2 storage cost ($0.015/GB-month, PRD §9.2 caveat).

## Alternatives considered

- **Update the v1 row in place.** Rejected: rates are immutable and old ledger rows must stay reproducible.
- **Pro-rate the change mid-period.** Rejected: Stripe prices a period's meter total at one price; blending would
  need per-day meters for a price cut that only benefits customers.
