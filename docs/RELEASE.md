# Release

Environments and gates per PRD §15. Checklists are completed in T38–T40.

- **Development:** local Next.js + local Supabase, dev R2 buckets, Stripe test mode, Inbucket email.
- **Preview (per PR):** Vercel preview, synthetic media only, never production secrets.
- **Staging:** separate Supabase project, R2 buckets, Worker routes, Stripe test customers; full Playwright, a11y,
  revocation, restore smoke and load tests.
- **Production:** DNS/TLS + `media.<domain>`, SPF/DKIM/DMARC, auth redirect allowlist, CORS + security headers,
  live Stripe prices and webhook secret, legal/privacy/tax review, pricing page matches config.

Rollback: redeploy previous Vercel + Worker versions; migrations are forward-compatible and run before code;
never stop consumers mid-job without draining; feature flags disable uploads/checkout.
