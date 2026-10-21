# 000. Monorepo tooling

Status: Accepted · Date: 2026-10-21 · Task: T01

## Context

Lumra spans a Next.js app on Vercel, two Cloudflare Workers and shared business logic that must not be duplicated
between them (PRD §13). The PRD proposes pnpm workspaces + Turborepo, TypeScript strict, Vitest, ESLint/Prettier.

## Decision

- **pnpm workspaces** (`apps/*`, `packages/*`, `tests/*`) with **Turborepo** for task orchestration and caching.
- **Internal packages ship TypeScript source** (`exports: ./src/index.ts`); Next.js transpiles them via
  `transpilePackages`, Wrangler/esbuild and Vitest consume them directly. No per-package build step.
- **TypeScript 6.0** in strict mode with `noUncheckedIndexedAccess`. TypeScript 7 (native) is deferred until
  typescript-eslint and Next.js support it.
- **ESLint 10 flat config** + typescript-eslint at the root; apps extend it (web adds `@next/eslint-plugin-next`).
- **Prettier** for formatting, checked in CI.
- **Vitest** for unit/integration tests in every package; **Playwright** for E2E in `tests/e2e`.
- **Zod 4** for env, API and queue contracts; types are inferred from schemas.

## Consequences

- Adding a package = create `packages/<name>` with the standard `lint/typecheck/test` scripts; Turbo picks it up.
- Workers bundle shared packages, so shared packages must stay runtime-agnostic (Web APIs only, no Node built-ins)
  unless explicitly server-only.

## Alternatives considered

- Nx: heavier and more opinionated than needed for ~10 packages.
- Building packages to `dist/`: slower feedback loop, no benefit while all consumers bundle.
