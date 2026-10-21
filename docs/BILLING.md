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
