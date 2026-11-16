-- Rate card v2 (owner decision 2026-11-16): Pro storage overage drops from $0.10 to $0.05 per
-- GB-month. Everything else is unchanged: Free = 2 active galleries + 1 GB hard cap; Pro = $2/month,
-- 20 GB-month included, $10 default spending cap. Delivery is not billed (ADR-008, ADR-009).
--
-- What it does (one transaction, data only — no DDL):
--   1. Inserts rate version 2 for 'free' and 'pro' (plan_rate_versions rows are immutable, so a
--      price change is a new version, never an update).
--   2. Repoints `plans.rate_version` to 2; the existing trigger re-projects the rate columns.
--
-- `decision` is a per-row column, not per value, so the v2 'pro' row is 'confirmed' and its notes
-- say which values are confirmed (base fee, 20 GB-month included, $0.05 overage) and which stay
-- proposed ($10 default cap). The v2 'free' row stays 'proposed' (2 galleries / 1 GB not confirmed).
-- v1 rows are untouched (a confirmed row can never go back, and v1 stays reproducible).
--
-- Behaviour of in-flight usage (documented in docs/BILLING.md "Rate card changes"):
--   * Existing `usage_ledger` rows keep `rating_version = 1` (append-only, never rewritten). Rows
--     accrued after this migration carry 2: the accrual job rates with `plans.rate_version`.
--   * `getRates(plan, version)` still reads v1, so rating a period whose ledger rows are all v1
--     (e.g. an invoice reconciliation of a period that closed before the change) keeps $0.10.
--   * A period that straddles the change mixes v1 and v2 rows. Its quantity is rated as one total
--     at the NEWEST version in the period (max rating_version): the whole period at $0.05. This
--     matches Stripe, which prices the period's meter total with the price on the subscription item
--     at invoice time (the items are moved to the v2 price with proration_behavior=none). The
--     per-row `estimated_cost_micro_usd` of v1 rows is a historical estimate and is not summed
--     for billing. A mid-period price cut therefore benefits the customer for the whole period.
--
-- Forward-only in production. Rollback / forward-fix: do NOT delete v2 (rows are immutable and
-- v2 ledger rows may reference it). To go back to $0.10 repoint the plans to v1, or better ship
-- a new version v3 carrying the intended rates:
--   update public.plans set rate_version = 1;       -- only before any v2 ledger row matters
-- and redeploy the previous web/worker and `lumra_pro_storage_overage_v1` Stripe price (an archived
-- Stripe price can be reactivated in the Dashboard).

insert into public.plan_rate_versions (
  plan_id, rate_version, monthly_fee_micro_usd,
  max_active_galleries, max_storage_bytes,
  included_storage_gb_month,
  storage_overage_micro_usd_per_gb_month,
  default_overage_cap_micro_usd, branding_visible, decision, notes
) values
  ('free', 2, 0, 2, 1000000000, 0, null, null, true, 'proposed',
   'v2 (2026-11-16): same as v1. Proposed: 2 active galleries, 1 GB storage hard cap.'),
  ('pro', 2, 2000000, null, null, 20, 50000, 10000000, false, 'confirmed',
   'v2 (2026-11-16): storage overage lowered to $0.05/GB-month by the owner. Confirmed: $2.00/month '
   'base, 20 GB-month included, $0.05/GB-month overage. Proposed: $10 default overage cap.');

update public.plans set rate_version = 2 where id in ('free', 'pro');
