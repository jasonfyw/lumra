# Lumra v1 (photos) — Implementation Plan

Derived from [`PRD.md`](./PRD.md) v1.0. Task IDs (T01–T40) match PRD §14 so issues, PRs and ADRs can cross-reference them. This file is the canonical task list; `node scripts/create-github-issues.mjs` mirrors it into GitHub issues (one epic per phase, tasks as sub-issues). Update this file when scope changes.

**Status:** T01 scaffold landed (monorepo, tooling, CI, env validators, route stubs, Worker skeletons). Remaining T01 follow-up: Vercel project + preview deploys (shared with T03).

**Ground rules (PRD §13–14):** one task = one bounded PR with tests + docs; contracts/schema change first; every state-changing endpoint gets an authorization test; every metered action gets ledger coverage; no media bytes through Vercel; no video in v1; T20 (secure gateway) must ship before anything is publicly previewable.

---

## 1. Architecture at a glance

```
Browser ──(HTML/JSON)──► Vercel / Next.js (apps/web)
   │                         │  Supabase Auth + Postgres (service role server-side only)
   │                         │  Stripe Checkout / Portal / webhooks
   │                         └─► job_outbox ──► Cloudflare Queues
   │                                               │
   ├──(presigned multipart PUT)──► R2 originals    ▼
   │                                       apps/worker (Queue consumers: outbox relay,
   │                                       cleanup, reconcile, metering export)
   │                                               │
   │                                       image processor container (sharp/libvips+HEIF)
   │                                       archive builder (streamed ZIP → R2 temp-archives)
   │
   └──(short-lived media token)──► apps/media-gateway (Worker on *.workers.dev until a custom domain exists)
                                     verifies JWS + access_version, streams from R2 binding,
                                     emits delivery-byte usage events
```

Shared code lives in `packages/*` so the web app, gateway and worker never duplicate business logic:

| Package                | Responsibility                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `@lumra/config`        | Zod env schemas per runtime, typed rate card, feature flags, numeric limits (guest quota, max file size, archive bounds)                      |
| `@lumra/contracts`     | Zod request/response/event schemas + inferred TS types (API §10, queue messages, media-token claims)                                          |
| `@lumra/domain`        | Pure logic: state machines (gallery/media/archive/billing), quota checks, ordering keys, slug gen, justified-grid layout, filename sanitising |
| `@lumra/db`            | DB client, typed queries/repositories; migrations live in `infra/supabase/migrations`                                                         |
| `@lumra/billing`       | Rating (integer micro-USD), ledger writers, reservation math, Stripe adapter                                                                  |
| `@lumra/media`         | Storage-key scheme, R2/S3 adapter (presign, multipart), magic-byte sniffing, derivative spec                                                  |
| `@lumra/observability` | Structured JSON logger, redaction (tokens/emails/IPs/signed URLs), request/trace IDs, health payload, Sentry scrubbing (T04)                  |
| `@lumra/tokens`        | HMAC JWS media tokens with `kid` rotation; gallery access-state KV store and writer (ADR-001)                                                 |
| `@lumra/ui`            | Design tokens, Tailwind preset, accessible primitives                                                                                         |

## 2. Decisions to record early (ADRs)

| ADR     | Decision                                | Recommendation (Proposed)                                                                                                                                   | Needed by              |
| ------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| ADR-000 | Monorepo tooling                        | pnpm workspaces + Turborepo, TS strict, ESLint flat config + Prettier, Vitest                                                                               | T01 (done in scaffold) |
| ADR-001 | Private media gateway vs presigned GETs | **Accepted:** Worker gateway with HMAC-SHA256 JWS (≤5 min, `kid` rotation), access-version check against KV with ≤5 s memo, fail closed                     | T20                    |
| ADR-002 | Image processor runtime                 | **Accepted:** Cloudflare Queue → Cloudflare Containers job running sharp with libheif; no native deps on Vercel                                             | T12                    |
| ADR-003 | ZIP implementation                      | Streamed STORE-mode ZIP (no recompression of JPEG/HEIC) built in the worker container, multipart-uploaded to R2; partitions ≤500 items / ≤2 GB              | T24                    |
| ADR-004 | Billing rating & Stripe mapping         | Internal append-only `usage_ledger` authoritative; Stripe Billing Meters for storage GB-month & delivery GB, exported daily with idempotency keys           | T27/T31                |
| ADR-005 | RLS & guest claim security              | Owner RLS on browser-readable tables; guest + billing + gateway tables service-only; claim requires guest cookie hash + verified session in one transaction | T02/T07                |
| ADR-007 | DB access layer                         | SQL-first migrations (Supabase CLI) + Drizzle as a typed query builder over the same schema (schema introspected, not generated migrations)                 | T02                    |

## 3. Epics & tasks

Legend: **Deps** = blocking tasks. **AC** = acceptance criteria (in addition to the PRD §14.1 definition of done: typed + validated interfaces, authz + error handling, tests, docs, observability, manual QA script, CI green).

### P0 — Foundation

**T01 Monorepo, CI, formatting, env validators** · Deps: none  
Scaffold the PRD §13 layout; pnpm + Turborepo; shared tsconfig/ESLint/Prettier; Vitest wiring; `@lumra/config` env schemas that fail fast on boot; GitHub Actions CI (install, lint, typecheck, test, build) + dependency scanning; `.env.example` per app; ADR-000.  
AC: `pnpm install && pnpm lint typecheck test build` green locally and in CI; invalid env aborts startup with a readable message.

**T02 Supabase schema + RLS** · Deps: T01  
All PRD §8 tables, enums, CHECK constraints (gallery ownership XOR before claim), indexes and partial indexes; RLS policies for owner tables; service-only tables locked down; seed fixtures; pgTAP or Vitest-against-local-Supabase RLS tests; Drizzle schema mirror; ADR-005/ADR-007.  
AC: `supabase db reset` reproduces schema+seed; RLS tests prove a user cannot read another user's galleries/media and anon/authenticated roles cannot touch guest/billing/outbox tables.

**T03 Deployed Next.js shell + design tokens** · Deps: T01  
App Router routes stubbed per PRD §4 (`/`, `/new`, `/auth`, `/dashboard`, `/g/[slug]`, `/account`, `/pricing`, `/archive/[jobId]`); Tailwind with `@lumra/ui` tokens (light theme, typography scale, motion tokens 180–320 ms, reduced-motion); security headers; Vercel project + preview deploys wired to synthetic-only env.  
AC: preview URL per PR; Lighthouse a11y ≥95 on shell pages; ≥320 px layouts without horizontal scroll.

**T04 Metrics/logging + health probes** · Deps: T01  
Structured JSON logger with request IDs (and trace propagation to queue messages), redaction of tokens/emails/IPs; Sentry in web/gateway/worker with source maps; `/api/health` sanitized liveness; API response envelope `{data,error,requestId}` helper and error codes.  
AC: thrown error in each runtime appears in Sentry with requestId; logs contain no secrets in a redaction unit test.

### P1 — Identity + guest drafts

**T05 Email OTP / magic link auth** · Deps: T02, T03  
Supabase passwordless (OTP + magic link) using `@supabase/ssr`; `/auth`, `/auth/confirm`; resend/error states; `returnTo` intent preserved; profile + free billing account row created on first sign-in; rate limiting on send/verify (FR-A05).  
AC: E2E sign-in with local Inbucket/Mailpit; expired/invalid OTP shows accessible error; redirect allowlist enforced.

**T06 Guest cookie, draft TTL, atomic quota reservations** · Deps: T02, T04  
`POST /api/v1/guest/drafts` and `GET .../current`; 256-bit capability in HttpOnly Secure SameSite=Lax cookie, only its hash stored; fixed 24 h expiry; atomic conditional update reserving file count + bytes (≤20 files / ≤250 MB) used by upload intents; IndexedDB stores draft ID + progress refs only; rate limits + configurable bot challenge (Turnstile) hook.  
AC: concurrency test — 21 parallel reservations ⇒ exactly 20 succeed; expired draft rejects uploads; cookie absent ⇒ 404.

**T07 Claim workflow incl. interrupted auth** · Deps: T05, T06  
`POST /api/v1/guest/drafts/claim`: single transaction transfers gallery, media and pending upload sessions to the user, marks guest session claimed, applies plan quota checks; publish button flow (Publish → auth → claim → publish); authenticated resume when the magic link opens in another browser (must still prove guest capability).  
AC: logged-in user without guest cookie cannot claim (security test); claim is idempotent; in-flight uploads continue after claim.

**T08 Authenticated dashboard** · Deps: T05  
`GET/POST /api/v1/galleries`; `/dashboard` text list (title, status, item count, created/updated, size, link actions), cursor pagination, sort by updated desc; empty state with New gallery.  
AC: owner-only authorization tests; 1,000 seeded galleries paginate correctly.

### P2 — Image upload

**T09 Private R2 + CORS + storage keys** · Deps: T01  
Wrangler config for `lumra-originals`, `lumra-derivatives`, `lumra-temp-archives` (dev/staging/prod), CORS limited to app origins for PUT, no r2.dev public access; storage-key builders in `@lumra/media` per PRD §6.2; scoped API tokens (presign-only creds for web).  
AC: anonymous GET of any key fails; key builder unit tests reject user-controlled path segments.

**T10 Multipart upload intent / sign / complete / resume** · Deps: T06, T09  
Endpoints `upload-intents`, `uploads/{id}/parts/sign`, `GET uploads/{id}`, `complete`, `abort`; quota reservation per intent (guest + plan); presigned part URLs bound to key/part/TTL 10–15 min; single PUT under 8 MiB threshold; SHA-256 verification strategy; idempotency via `clientId`; finalize writes outbox `media.uploaded`.  
AC: interrupted upload resumes from server-reported parts; size mismatch rejected; cannot sign parts for another user's upload.

**T11 Photo content validation + metadata** · Deps: T10  
Client-side pre-check (extension + magic bytes + size) and authoritative server/worker sniff (JPEG/PNG/WebP/HEIC); reject truncated files, decompression bombs (pixel limit), unsupported HEIC variants with actionable codes; extract width/height/orientation/taken-at.  
AC: fixture corpus (renamed exe, truncated JPEG, 50k×50k PNG bomb, HEIC variants) all classified correctly.

**T12 Derivative pipeline with retries/DLQ** · Deps: T11, ADR-002  
Outbox relay → Cloudflare Queue → processor container: EXIF orientation normalised, ICC → sRGB, metadata stripped, widths 320/640/1280/2048 (no upscale) WebP (+JPEG fallback if needed); `media_variants` rows; idempotent writes that check `deleted_at`/content version; exponential backoff, DLQ, replay script.  
AC: golden-image tests for orientation/ICC; poison message lands in DLQ without blocking queue; deleted media mid-processing writes nothing.

**T13 Reconciler / cleanup jobs** · Deps: T10, T12  
Scheduled jobs: expire guest drafts (24 h) and stale reservations (48 h auth); abort orphaned multipart uploads; delete R2 objects without DB rows; re-enqueue media stuck in processing; gallery/media deletion executor with retries (<24 h SLO); metrics for each.  
AC: each reconciler has an integration test with seeded drift; jobs are safe to run concurrently/repeatedly.

**T14 Upload UX** · Deps: T10, T11, T03  
`/new` and editor upload zone: drag/drop + mobile picker, per-file and total progress, states queued→uploading→uploaded→processing→ready / failed / cancelled, retry with jitter, 3 concurrent (desktop) / 2 (mobile), resume prompt when File can't be reselected, polling for processing status, `aria-live` announcements.  
AC: Playwright test with throttled network + forced part failure recovers; keyboard-only operation works.

### P3 — Gallery delivery

**T15 Gallery editor CRUD / order / cover** · Deps: T08, T10  
`/dashboard/galleries/[id]`; PATCH title/cover; fractional ordering keys (`@lumra/domain`) and `PATCH media/order`; delete media (revoke + enqueue cleanup); delete gallery (sync revoke + async purge, FR-G06); long-press/drag reorder with accessible move-up/down alternative; free plan gallery count limit.  
AC: reorder stable across pagination; deleted gallery 404s publicly before the response returns.

**T16 Publish-during-upload + placeholders** · Deps: T07, T15  
`POST galleries/{id}/publish` (slug immutable, `published_at` set once, optional password/expiry); public payload includes non-ready items as placeholders; recipients poll for readiness; creator sees recoverable unavailable tiles, recipients see neutral placeholders.  
AC: E2E scenario §14.2-3 (link usable before upload completes; tiles fill in without refresh).

**T17 Public hero + justified virtualized grid** · Deps: T16, T20  
`/g/[slug]` SSR metadata (no protected HTML caching); hero = override cover or first ready photo; justified layout algorithm in `@lumra/domain` (row heights 180–280 desktop / 110–190 mobile), windowed rendering for 2,000 items, `srcset` from variants, intrinsic sizes (no CLS); Lumra badge for free plan.  
AC: 2,000-item fixture keeps DOM nodes bounded; CLS ≈ 0; LCP budget in CI.

**T18 Lightbox + mobile UX** · Deps: T17  
Fullscreen accessible dialog: focus trap/restore, Esc/arrows/swipe, adjacent prefetch, download original button, reduced-motion handling, shared-element transition when feasible.  
AC: axe clean; keyboard + touch E2E on mobile viewport.

**T19 Gallery password + expiration** · Deps: T16  
Argon2id hashing; `unlock` endpoint (rate limited) issuing HttpOnly gallery session; password change/expiry change bumps `access_version`; computed expired state with consistent expired page; creator can extend/remove expiry.  
AC: security matrix rows for password change and expiry pass; brute force throttled.

**T20 Private gateway / tokens / access revocation** · Deps: T09, T16, ADR-001  
`media-tokens` endpoint minting ≤5 min tokens (`aud`, `gallery_id`, `media_id`, `variant`, `action`, `access_version`, `jti`); `apps/media-gateway` verifies signature, checks access version/deleted/expired via KV-cached state (≤ seconds, fail closed), streams from R2 binding with correct cache/CORS/Content-Disposition, supports Range for originals, emits delivery-byte events; contract shared via `@lumra/contracts`.  
AC: PRD §11 rows (guessed key, expired token, password change, deletion mid-download) automated in `tests/security`.

**T21 Share / QR / native share** · Deps: T16  
Share sheet: Copy link (primary), QR (downloadable PNG), Web Share API with copy fallback.  
AC: works on iOS Safari/Android Chrome emulation; QR decodes to share URL.

### P4 — Downloads + analytics

**T22 Single original download** · Deps: T20  
`action=original` tokens; exact bytes with `Content-Disposition: attachment` and safe filename; Range support; download event recorded once per initiated action.  
AC: SHA-256 of downloaded file equals uploaded file.

**T23 Multi-select** · Deps: T17, T22  
Selection mode on grid (tap/checkbox, keyboard), selection bar with count + Download; single item → direct download, multiple → archive request.  
AC: accessible selection state announced; mobile never fires parallel downloads (FR-D05).

**T24 Streaming background archives / parts** · Deps: T12, T20, ADR-003  
`POST public/galleries/{slug}/archives`; job bound to `content_version`; partition ≤500 items/≤2 GB; streamed ZIP built in worker container, uploaded multipart to `temp-archives`; sanitized, collision-suffixed filenames; resumable/idempotent; reuse existing ready archive for same content version.  
AC: `../` filename test; 2,000-item gallery yields ≥4 parts; gallery change during build fails/recreates job.

**T25 Archive progress + TTL** · Deps: T24  
`/archive/[jobId]` page + `GET public/archives/{jobId}` (progress, part links via gateway); 24 h retention and cleanup; failure/retry UX.  
AC: expired archive shows clear state; lifecycle job removes objects.

**T26 Views / download counts + list metadata** · Deps: T08, T22  
`POST analytics/events` (one view per anonymous session per gallery per 30-min bucket, bot filter, creator preview excluded); download counts split item/archive; `GET galleries/{id}/analytics`; dashboard columns.  
AC: dedupe unit tests; no third-party trackers.

### P5 — Billing

**T27 Rate card, internal metering, reservation logic** · Deps: T02  
Versioned rate card in DB/config; `@lumra/billing` rating in integer micro-USD; storage GB-month integration from byte-seconds; delivery ingestion from gateway events; cost reservations for uploads/archives; ADR-004.  
AC: deterministic tests reproduce PRD §9.3 example ($4.20); no floating-point money.

**T28 Free caps** · Deps: T27, T10  
Enforce 2 active galleries, 1 GB stored, 3 GB/month delivery; upload admission integrated with reservations; graceful "temporarily unavailable" page when delivery cap hit.  
AC: free user can never create a positive overage ledger entry (property test).

**T29 Checkout / Portal / webhooks** · Deps: T05, T27  
Stripe Checkout (subscription $2), Billing Portal, raw-body signature verification, `provider_webhook_events` dedupe, outbox for side effects.  
AC: replayed webhook is a no-op (G-06).

**T30 Subscription entitlements** · Deps: T29  
Entitlements derived only from confirmed webhook state; plan switch updates limits + branding; billing account state machine (`free/active/past_due/restricted/canceled`).  
AC: E2E §14.2-8 activates Pro exactly once.

**T31 Usage export / invoices / reconciliation** · Deps: T27, T29  
Daily export of ledger to Stripe meters with stable idempotency keys (`billing_exports` cursor); invoice history link; reconciliation report + alert on >10% drift.  
AC: re-running export produces no duplicate meter events.

**T32 Spending caps + alerts** · Deps: T27, T28  
`/account` cap control ($0–max, default $10), 50/80/100% deduped emails + banner, admission denial at cap, delivery safety cutoff with bandwidth-limit notice.  
AC: cap respected within documented tolerance in simulated traffic test.

**T33 Payment-failure states** · Deps: T30  
`past_due` → stop uploads/archives immediately; 7-day grace then suspend public delivery; 30-day retention; transition notifications.  
AC: time-travel tests for each transition.

### P6 — Hardening + launch

**T34 Threat model + adversarial test matrix** · Deps: P3–P5 — automate every PRD §11 row in `tests/security`; written threat model.  
**T35 Performance: 2,000-item gallery** · Deps: T17 — k6/Artillery + Lighthouse CI budgets (p75 LCP <2.5 s, p95 API <500 ms).  
**T36 Mobile/device tests** · Deps: T18, T14 — Playwright device matrix + manual iOS/Android checklist.  
**T37 Backups/restore drills** · Deps: T02 — PITR config, documented restore, first drill executed.  
**T38 Monitored staging** · Deps: T04 — separate Supabase/R2/Workers/Stripe-test env, alerts per PRD §15, runbooks.  
**T39 Production Stripe + Cloudflare smoke tests** · Deps: T29, T20 — live prices, webhook secret, DNS/TLS, SPF/DKIM/DMARC, smoke script.  
**T40 Public launch gate** · Deps: all — checklist: §14.2 scenarios pass, legal/privacy review, pricing page matches config, rollback rehearsed.

### v1.1 — Video (deferred, not started)

V01–V06 per PRD §16; tracked as a single placeholder epic until v1 is stable.

## 4. Critical path & suggested order

```
T01 ─┬─ T02 ─┬─ T05 ─┬─ T07 ── T16 ─┬─ T19
     │       │       └─ T08 ── T15 ─┘   └─ T20 ── T17 ── T18 ── T23 ── T24 ── T25
     │       └─ T06 ── T10 ── T11 ── T12 ── T13
     ├─ T03          └─ T14
     ├─ T04
     └─ T09
T27 ── T28 ── T32 ;  T29 ── T30 ── T33 ; T31     (start after T02; must gate T10 admission before public release)
```

Parallelisable streams once P0 lands: (a) auth/drafts (T05–T08), (b) storage/upload (T09–T13), (c) billing core (T27), (d) UI shell/grid layout algorithm (T03, T17 layout math).

## 5. Product-owner decisions

| #   | Question                               | Decision (2026-11-05)                           | Implications                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Production domain                      | `lumra.vercel.app`                              | Auth redirect allowlist and `NEXT_PUBLIC_APP_URL` use it. A custom subdomain can't be put on `vercel.app`, so the media gateway runs on its `*.workers.dev` URL. Tokens travel in the URL, so a cross-origin gateway works. Revisit `media.<domain>` if a custom domain is bought.                                                |
| 2   | Image processor host                   | Cloudflare Containers (ADR-002)                 | Processor, archive builder and queues all on Cloudflare; R2 accessed via bindings with no egress.                                                                                                                                                                                                                                 |
| 3   | Transactional email                    | Resend as Supabase custom SMTP (agent's choice) | Local dev uses Supabase's built-in Inbucket. **Launch blocker:** Resend (like every reputable provider) needs a verified sending domain with SPF/DKIM/DMARC, and `vercel.app` can't be verified. Supabase's default SMTP is rate-limited to a few emails/hour and is not for production. Buy a domain before public launch (T39). |
| 4   | Proposed commercial defaults (PRD §17) | Open                                            | Confirm before T27 fixes rate-card v1.                                                                                                                                                                                                                                                                                            |
