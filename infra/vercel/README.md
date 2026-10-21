# Vercel

- Project root: `apps/web`; framework preset Next.js; install command `pnpm install --frozen-lockfile`.
- Build command: `pnpm turbo run build --filter=@lumra/web`.
- Environments: **Preview** uses dev Supabase/R2/Stripe test keys with synthetic media only; **Production** uses production
  secrets. Preview deployments must never receive production R2 or Stripe credentials (PRD §15).
- Env vars are documented in `apps/web/.env.example` and validated by `packages/config/src/env.ts` at boot.
- No route handler may accept or proxy media bytes (4.5 MB body limit; PRD FR-M02).
