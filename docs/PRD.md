# Lumra — Product Requirements & Agent-Ready Implementation Specification

**Version:** 1.0 (baseline)  
**Prepared:** 20 October 2026  
**Status:** Implementation-ready proposal, with configurable commercial assumptions  
**Release:** v1 photos only; v1.1 video  
**Primary audience:** Product owner, Codex, Claude Code, and technical reviewers

> **Implementation contract:** The decisions explicitly confirmed during eight discovery rounds and final clarifications are authoritative. Where implementation detail was not chosen, this document specifies an opinionated default marked **Proposed**. Changes to a confirmed requirement must be recorded as an architectural/product decision; prices and service fees must be checked before enabling live billing.

## 1. Executive summary

Lumra is a minimal, premium-feeling media delivery platform. Anyone can begin creating a gallery without creating an account, upload files, then authenticate only at publishing (or earlier if guest limits are exceeded). The creator shares a simple link; recipients browse an immersive, justified gallery and download originals singly, as a selection, or all at once. The product prioritizes getting a first gallery ready to share in **under 60 seconds of active workflow time, excluding file transfer/processing**.

**v1 includes:** photo ingestion (JPEG, PNG, WebP, HEIC), image derivatives, draft guest flow, passwordless email authentication, gallery creation/editing/reordering, publication during uploads with placeholders, publicly shareable and optionally passworded galleries, expiration controls, original downloads, background ZIP jobs, basic analytics, minimal dashboard, secure private media delivery, usage quotas, $2/month Pro with metered overages, Stripe subscriptions/invoices, spending alerts and caps, monitoring/backup/cleanup. Light mode only. Mobile creation and viewing are first-class.

**v1 excludes:** video upload, streaming, transcoding, and video processing charges; RAW images; commenting/favourites/client selections; nested folders; personal portfolio sites; extensive theming; invite-only access; sophisticated analytics; custom domains; native apps. **v1.1** adds MP4/MOV video, original preservation in R2, managed transcoding/playback, poster generation, and video metering.

### 1.1 Confirmed product decisions

- Audience: anyone sharing media, with initial pricing and delivery workflows oriented toward freelance creatives.
- Value proposition: create, upload, publish, share with very few decisions.
- Guest draft: up to **20 files or 250 MB total**, whichever limit is reached first; recoverable in the original browser, expires **24 hours** after creation. Require auth if either threshold would be exceeded. Guest signup is normally triggered by Publish/Share.
- Gallery: flat, justified layout; large hero and title; first suitable image is the default cover, overrideable; fullscreen accessible lightbox.
- Editing after publication: add/remove/reorder files, rename gallery, change cover/password/expiration, and sharing.
- Publication during uploads: gallery link becomes live immediately and incomplete media appear as placeholders, with ready media viewable progressively.
- Recipients: read-only; original-quality single, multi-select and all downloads; share via copy link, QR, and native share if available.
- Minimal creator dashboard: text-based list of name, item count, created/updated timestamps, access/publication status, storage size; gallery views and download counts.
- Gallery deletion: immediate public inaccessibility upon confirmation and asynchronous permanent physical object deletion with reliable retries.
- Free tier: one or two galleries and 1 GB storage (launch default specified below); visible Lumra branding. Paid tier: **USD $2/month base fee** with small allowance and metered overages; branding removed.
- Pricing controls: monthly invoice, alerts and configurable spending cap restricting billable activity.
- Stack: Next.js/React/TypeScript on Vercel; managed PostgreSQL/auth (Supabase); Cloudflare R2/CDN/media layer; worker/queue processing; Stripe; designed for Codex/Claude Code.
- Public launch with fewer than 100 users, aiming for 10–20 genuine users delivering galleries.

### 1.2 Reconciled apparent conflicts

1. “Ship all Round 1–7 capabilities” vs “photos first”: all **photo-relevant** requirements are v1; video-specific requirements are reserved for v1.1.
2. “Signup only on publish” vs “signup on large guest uploads”: publish is default conversion point; guest quota enforcement is the documented exception.
3. “Publish during upload” vs “downloads only when original ready”: publish and gallery-level access are immediate; each item independently progresses to downloadable readiness. Placeholder tiles are non-downloadable.
4. “Permanent link” vs “expiration”: permanence controls default access duration, **not guaranteed lifetime storage**; expired shares are recoverable by the creator and media remains stored/billable.
5. “Immediate deletion” vs eventual storage deletion: application revokes all access synchronously before asynchronous object cleanup. No self-service Trash.
6. “Pay as you go” vs $2/month: Pro is a subscription with included units and metered overages, not pure usage-only billing.

## 2. Goals, measurable outcomes, non-goals

### 2.1 Goals and launch acceptance

| ID | Goal | Acceptance |
|---|---|---|
| G-01 | First-gallery speed | In usability test with 10 first-time participants, >=8 complete create→upload initiation→publish→copy link within **60 seconds of active interaction**, excluding network upload and email delivery/OTP wait; record separate end-to-end time. |
| G-02 | Real usage | >=10 distinct real creators publish a gallery and at least one recipient opens it within 30 days; stretch target 20. |
| G-03 | Recipient reliability | 99%+ successful original downloads in synthetic and observed tests (exclude client disconnects); no access leakage. |
| G-04 | Scale | 2,000 items can be browsed without loading all thumbnails into the DOM at once; acceptable on mainstream mobile and desktop. |
| G-05 | Security | Unauthorized download attempts denied; expired/passworded/private assets cannot be retrieved by guessing storage keys. |
| G-06 | Billing integrity | No free-user overage; no duplicate Stripe charges for replayed webhooks/metering jobs; monthly caps respected within documented reservation tolerance. |

**Proposed SLOs** (not service guarantees at beta): 99.9% monthly application availability; p95 API read latency <500 ms excluding external media/transfer; p75 LCP <2.5 seconds on representative mobile network for a normal published gallery; p95 first meaningful media thumbnail <3 seconds under test fixtures; error rate <1% for upload finalization excluding client network errors. Record test methodology and performance budgets in CI.

### 2.2 Explicit non-goals

No social feed, albums-within-albums, client proofing, editing tools, RAW processing, selling prints, invoicing clients, custom gallery themes, elaborate page builder, team management, or enterprise compliance features for v1. Do not implement speculative features in agent tasks.

## 3. Personas and canonical journeys

**Creator:** freelance photographer delivering several hundred photos; wants rapid setup, reliable originals, simple billing. **Casual creator:** shares event/travel photos occasionally on Free. **Recipient:** opens mobile/desktop link, browses without an account, downloads one, selected or all photos.

**J1 Guest-to-published:** Open landing → Create Gallery → temporary gallery immediately created → drag/drop or mobile picker → uploading tiles appear → edit optional title/cover → Publish → enter email → verify magic link/OTP → ownership of guest draft transferred atomically → published link shown; any in-flight items continue uploading/processing → Copy/QR/native share.

**J2 Returning creator:** authenticate → dashboard list → open gallery → append/delete/reorder/rename → view current storage, views and downloads → re-share.

**J3 Recipient:** open `/g/{slug}` → if password protected, submit password → hero/justified grid loads → view item lightbox with left/right/swipe/keyboard navigation → download original or select tiles for multiselect/ZIP → get progress/status for archive.

**J4 Expiration:** gallery link passes `expires_at` → recipients see consistent expired page (not asset bytes) → creator can extend/remove expiry → original URL works again without re-upload.

**J5 Spending cap:** usage/reserved costs near threshold → warning email and account banner → at cap, deny new uploads and expensive new archive jobs; policy for already shared gallery media described in §9.4.

## 4. Screens, information architecture and UX contracts

| Screen / route | Purpose / essential components |
|---|---|
| `/` | Sparse marketing page, hero CTA **Create gallery**, 3-step benefit, pricing link, sign in. |
| `/new` | Instant draft creation; upload zone, list of file states, optional title, CTA Publish/Share; no modal onboarding. |
| `/auth` and `/auth/confirm` | Email OTP or magic link; accessible error/resend states; guest intent preserved. |
| `/dashboard` | Minimal list; New gallery; name, published/draft, item count, created/updated, size, link actions. |
| `/dashboard/galleries/[id]` | Edit title/cover, reorder, add/remove media, share, password/expiration, analytics, delete. |
| `/g/[slug]` | Hero cover + title + justified mixed-aspect photo grid (v1 photos only), password gate when needed. |
| `/account` | Email, plan, small storage/bandwidth usage summary, invoice link, spending cap and alerts. |
| `/pricing` | Transparent Free/Pro usage and charges with representative examples and rate definitions. |
| `/archive/[jobId]` | Archive preparing/progress/ready/failure/expired; retriable errors and clear time estimates only when calculable. |

**Responsive design:** mobile-first responsive breakpoint system; usable ≥320 CSS px. Drag/drop desktop, native multi-file picker mobile; touch-friendly hit targets ≥44x44 CSS px; long-press reorder (with accessible non-drag alternatives). Light theme only. Typography should be intentional, images visually dominant. Motion: 180–320 ms microinteractions, shared-element transitions when feasible; `prefers-reduced-motion` disables nonessential motion. Maintain keyboard navigation, focus order, screen-reader labels, visible focus indicators and WCAG 2.2 AA-oriented contrast.

**Justified grid:** compute rows from intrinsic aspect ratios at container width; maintain natural row heights ~180–280 px desktop and ~110–190 px mobile (tunable); do not crop by default. Use responsive thumbnails, `srcset`, lazy loading, virtualization/windowing for 2,000 items, and preserve aspect ratios to avoid layout shift. Lightbox supports Escape, arrows, swipe, next/prev, full original download; no auto-navigation or autoplay.

**Hero:** first ready still photo by upload order automatically selected; fallback neutral placeholder until available; creator can override. Cover media selection is data, not a separate original object.

**Upload UI state:** queued → uploading (bytes/percent) → uploaded → processing → ready; recoverable failed, cancelled, removed. Expose per-file and total progress; a published gallery shows placeholder tiles with appropriate accessible text until ready. An upload that never finishes displays a recoverable unavailable tile to creator but a neutral placeholder/error to recipient; recipient must never see internal infrastructure errors.

**Sharing UI:** Copy Link primary, QR code downloadable as PNG or copied as needed, use Web Share API when supported with Copy fallback. No email invite system in v1.

## 5. Functional requirements (MUST for v1 unless marked otherwise)

### 5.1 Authentication and guest drafts

- FR-A01: Create guest draft on one action without account; issue 128-bit+ unguessable guest capability in **HttpOnly Secure SameSite=Lax** cookie; keep draft ID and non-sensitive recoverable progress references in IndexedDB. Avoid storing raw photos in browser persistence.
- FR-A02: Guest quota fixed at <=20 accepted items and <=250,000,000 accepted source bytes (decimal MB); quotas checked **before issuing every upload reservation** and under a database lock/atomic conditional update. Guest requests larger than permitted require email verification before upload.
- FR-A03: Expire draft 24 hours after creation (fixed expiration, no indefinite refresh), deny new guest uploads, expire bearer capability, and enqueue R2 cleanup. Publication transfers records and existing pending upload reservations into authenticated ownership transactionally.
- FR-A04: Email OTP/magic link only (Supabase). Verify server-side and bind auth to same draft capability; if opened in new browser, user may manually authenticate then return to original browser, or use an authenticated resume flow that proves guest capability. Do not transfer based solely on a draft ID.
- FR-A05: Rate limit guest creation, login sends/attempts, password attempts, upload authorization and public traffic. Bot challenges at suspicious thresholds; abuse thresholds configurable.

### 5.2 Gallery CRUD and publication

- FR-G01: Create/rename gallery; title auto-default "Untitled gallery" and may be changed later. Generate random URL-safe slug (no personally identifying filename); allow stable URL after name edits.
- FR-G02: Gallery states draft, published, expired, deleted; publication commits independently of item readiness. `published_at` set once, stable share slug; show share link immediately.
- FR-G03: Creator can add/remove/reorder, modify cover, password, expiration, and sharing status after publication. Use fractional ordering keys or sparse sortable integer ranks; rebalances atomic, stable across pagination.
- FR-G04: Password optional; hash with Argon2id/scrypt; never store plaintext. Successful password challenge issues a session for that gallery. Changing password increments access version, revoking old media authorizations.
- FR-G05: Expiration either `null` (non-expiring link) or selected timestamp; expiration time interpreted in UTC, with UI local conversion. Expiration is access-only; storage remains and counts toward billing.
- FR-G06: Immediate deletion confirms irreversibility, sets deleted flag/access epoch before responding, invalidates sessions/tokens and published share, enqueues idempotent removal of originals/derivatives/archives. Physical deletion SLO <24 h, except provider outages; reconcile orphaned objects daily.
- FR-G07: Free plan **Proposed launch cap: 2 active galleries, 1 GB total originals+derivatives**; paid gallery count unlimited subject to anti-abuse and max 2,000 items/gallery. Exceeding allowed creation/storage blocks further uploads, not viewing of already legitimate galleries.

### 5.3 Photo ingestion, metadata, derivatives

- FR-M01: JPEG/JPG, PNG, WebP, HEIC; max **50,000,000 bytes** per photo. Detect real file type from content/magic bytes, not filename alone; reject malformed, truncated, image decompression bombs or unsupported encodings; virus/malware inspection as applicable.
- FR-M02: Upload originals straight browser→private R2 via bounded-lifetime presigned multipart PUTs; **never send original file bytes through Vercel APIs**. `Content-Type`, object key, part count, file size, and owner bound to upload intent. Prohibit overwriting another item's key.
- FR-M03: Use multipart/resumable upload for files above configurable threshold (Proposed 8 MiB); persist part ETags/IDs (non-secret) client-side and reconcile server-side when resuming. Retry individual parts with jitter and capped backoff; total 3 concurrent files (desktop), 2 mobile, adjust by connectivity. On inability to reselect a browser File, show clear resume prompt.
- FR-M04: Finalize only after verifying object exists, total bytes match reserved size and integrity check passes (SHA-256 if feasible; multipart ETag is **not** treated as whole-file checksum). On finalization, enqueue image processing and update database idempotently.
- FR-M05: Preserve originals byte-for-byte; normalize EXIF orientation in generated derivatives, apply embedded ICC profiles into sRGB for web previews where needed, strip sensitive metadata from derivatives; preserve originals' metadata. Reject unsupported HEIC variant with actionable error.
- FR-M06: Produce thumbnail widths **320, 640, 1280, 2048 px** as feasible (don't upscale), modern encoded WebP or AVIF with JPEG fallback if required by browser; use controlled quality and a single master pipeline; process asynchronously outside Vercel functions.
- FR-M07: Derivatives and originals private by default. Track metadata width, height, orientation, source bytes, MIME, taken timestamp when available, processing state and exception class.
- FR-M08: No RAW/video ingestion in v1. Clear client-side unsupported-format rejection before upload start.

### 5.4 Viewing, sharing and downloads

- FR-V01: Recipients can access published non-expired non-deleted galleries through unguessable slug; no account required. Passworded galleries require valid gallery session before metadata and media are revealed.
- FR-V02: Media URLs are authorized separately from HTML; cannot bypass passwords with direct R2 object paths. Use short-lived scoped media tokens, gateway permission checks, and short cache validity. A signed URL alone is bearer access until expiry; choosing ≤5 min controls exposure but is not immediate revocation unless gateway checks state.
- FR-V03: Fullscreen lightbox with accessible keyboard/touch interaction; transitions not required for functioning under reduced-motion setting.
- FR-D01: Single download serves **exact original file** with `Content-Disposition: attachment`; no reencoding. Support byte-range requests for large originals if gateway implementation supports them securely.
- FR-D02: Multi-select and Download All create ZIP archives containing original images with safe filenames, deterministic collision suffixes, a manifest optional; filename paths sanitized to prevent traversal.
- FR-D03: Background archive assembly is queued, resumable/idempotent, reports preparing/processing/ready/failed; ZIP bytes never routed through Vercel. **Proposed job bound:** max 2 GB of originals per archive and up to 500 items per archive; requests exceeding bound generate multiple partitioned archives automatically with clear download links. A complete gallery may therefore generate 4+ archives. This is a v1 implementation constraint, not a reduction in Download All availability.
- FR-D04: Archive output stored in private R2 with short retention (Proposed 24 h), issued via scoped gateway, and cleaned by lifecycle job. Re-download count counts archive as one download action; bytes account to delivery meter once per actual response byte served.
- FR-D05: Browser-download limitations on mobile must be handled with single archive links, not hundreds of parallel browser downloads.

### 5.5 Analytics and dashboard

- FR-N01: Dashboard list includes title, created/updated dates, status, image count, total stored bytes; sorting last modified desc; pagination/cursor.
- FR-N02: Basic **gallery views** count one eligible view per privacy-safe anonymous session per gallery per 30-minute window; filter obvious bots and creator preview. **Downloads** count successfully initiated original/ZIP download actions; distinguish item and archive in backend even if UI shows total. Avoid third-party invasive tracking.
- FR-N03: Usage summary is limited to storage GB-month estimate, delivery GB current billing cycle, paid plan, active spending cap, estimated spend, and invoice history link.

## 6. Infrastructure design and boundaries

### 6.1 Runtime placement

- **Vercel Next.js:** server-rendered UI, auth callbacks, REST route handlers, gallery metadata, upload reservations/finalization, access session issuance, Stripe checkout/portal/webhooks, signed media-token issuance, administrative endpoints; no media byte proxying.
- **Supabase Postgres/Auth:** durable state, billing usage ledger, row-level policies, atomic quota reservations, guest session records; service role exclusively on trusted server/worker.
- **Cloudflare R2 Standard:** `lumra-originals`, `lumra-derivatives`, `lumra-temp-archives` (can be distinct buckets or prefixes with distinct credentials); buckets private; encryption at rest and TLS in transit.
- **Cloudflare Worker media gateway:** served on `media.<domain>`; validates signed gallery tokens with short TTL, enforces gallery access version/expiration (using short-lived signed access claims plus cheap access-epoch store/revalidation strategy), fetches R2 via binding, emits response with correct cache rules and CORS. For strict immediate revocation check authoritative revocation version on each authorization (cache revocation lookup bounded to seconds, fail closed on unavailable state); never cache protected HTML or decisions across users.
- **Background jobs:** Cloudflare Queues/Workers for scheduling/retries, image processing via isolated worker/container service capable of HEIC decoding (Proposed: managed container job with libvips/sharp+HEIF support; avoid native binary deployment inside Vercel), archive generation via job runner with streamed/chunked IO. Queue messages carry IDs, never secrets or file blobs.
- **Stripe:** Checkout subscription creation, Billing Portal, invoices, usage meters or aggregated invoice items. Treat Stripe as billing processor, internal immutable ledger as authoritative for realtime cap checks.
- **Monitoring:** Sentry (app/worker), structured logs, availability checks, queued-job age alerts, metrics for error rate and spending. Database PITR/backups require plan support and verified restorations.

### 6.2 Security model

**Access matrix:** guest capability may modify only its draft within quota; creator access requires `auth.uid() = owner_id`; public viewer may read only published, unexpired gallery after valid password session if configured; media gateway permits only named item and action (preview/original/archive) with proper gallery authorization. No storage bucket is configured for anonymous `r2.dev` reads.

**Token design (Proposed):** Next.js issues an asymmetric JWT/JWS or HMAC with `aud=lumra-media`, `gallery_id`, `media_id`, `variant`, `action`, `access_version`, `exp<=5 min`, `jti`; verification at gateway. For public unpassworded gallery, page requests obtain token for a bounded set of visible tiles; don't expose long-lived signer secrets to browser. Validate origin/anti-CSRF for state-changing endpoints, using SameSite cookies plus CSRF token where necessary. Optional password sessions use HttpOnly cookie scoped to Lumra application origin; token minting checks it. Rotating gallery password/revocation must invalidate token via access version check.

**Upload URL design:** presigned R2 PUT/part URLs limited to specific keys/part numbers and short TTL (~10–15 minutes); no list/read/delete permissions and no broad bucket credentials in client. Limit excessive in-flight reserved bytes and request rates.

**Privacy:** minimal personally identifying data (email, billing customer ID); do not log passwords, tokens, object access URLs, user-supplied filenames unnecessarily, or full IP addresses. Collect explicit privacy/terms acceptance when required, publish retention policy, provide data export and deletion workflow, and respect US/Canadian privacy requirements with legal review before public launch.

**Storage key scheme:** `originals/{user-or-guest-opaque-id}/{gallery_uuid}/{media_uuid}/source`; `derivatives/{gallery_uuid}/{media_uuid}/{variant_hash}.webp`; `archives/{gallery_uuid}/{job_uuid}/{part_no}.zip`. Never use user-controlled filename as object key.

### 6.3 Reliability principles

All external webhooks and queue jobs idempotent, with dedupe keys and optimistic locking; exponential backoff, bounded retries, dead letter queue and manual replay tooling. Use transactional outbox when DB write plus message publication must agree. Reconcile: pending uploads without objects, R2 objects without DB records, published media with no derivatives, finished archive jobs lacking output, Stripe billed events vs ledger. Avoid distributed global transactions; use state machines and compensating cleanup.

## 7. State machines and consistency

**Gallery:** `draft → published → expired` (expiry calculated from timestamp); `published/expired → deleted`; expired → published when creator adjusts expiry. Deleted is terminal. "Expired" may be computed rather than persisted to avoid missed cron.

**Media:** `reserved → uploading → uploaded → processing → ready`; `uploading/processing → failed` with retry path; any non-deleted → `deleting → deleted`. Publishing has no dependency on item ready state. In-progress upload reservations keep stable placeholders; if not recovered in 24 h (guest) or 48 h (authenticated, Proposed), fail/clean them.

**Archive:** `requested → queued → running → ready` or `failed`; ready→expired/deleted. Repeated requests within retention may return existing archive if gallery content version identical and authorization still holds.

**Billing account:** `free → trialing?` (trial not planned) `active → past_due → restricted → canceled`; deletion/access restrictions follow policies, not just Stripe status.

## 8. Data model (PostgreSQL baseline)

All UUID PKs, timestamps UTC (`timestamptz`), monetary amounts in integer **micro-USD** internally for rating; Stripe amounts in minor currency units; `BIGINT` for bytes and integer counters. Include `created_at`, `updated_at` on mutable tables. Representative schema:

| Table | Required fields / constraints |
|---|---|
| `profiles` | `user_id UUID PK REFERENCES auth.users`, email, display_name nullable, `plan_id`, `created_at` |
| `guest_sessions` | `id UUID PK`, `capability_hash`, `expires_at`, `claimed_by_user_id NULL`, `reserved_file_count`, `reserved_bytes`, `rate_key_hash`, timestamps |
| `galleries` | `id UUID PK`, `owner_id NULL`, `guest_session_id NULL`, `slug TEXT UNIQUE`, `title`, `status`, `password_hash NULL`, `access_version INT`, `cover_media_id NULL`, `expires_at NULL`, `published_at NULL`, `content_version INT`, `deleted_at NULL`, timestamps; CHECK exactly one ownership before claim / creator only after claim |
| `media` | `id UUID PK`, `gallery_id FK`, `original_key UNIQUE`, `filename`, `mime`, `byte_size BIGINT`, `width`, `height`, `sort_key`, `status`, `upload_session_id`, `ready_at`, `failure_code`, `deleted_at`, timestamps |
| `media_variants` | `id`, `media_id FK`, `variant`, `object_key UNIQUE`, `mime`, `width`, `height`, `byte_size`, `ready_at`; UNIQUE `(media_id,variant)` |
| `upload_sessions` | `id`, `gallery_id`, `media_id`, `provider_upload_id NULL`, `part_size`, `reserved_bytes`, `expires_at`, `status`, `idempotency_key UNIQUE`, `completed_at`; server verifies object state |
| `archive_jobs` | `id`, `gallery_id`, `requested_by_session_hash`, `content_version`, `status`, `parts_expected`, `progress_pct`, `expires_at`, `failure_code`, timestamps |
| `archive_parts` | `id`, `job_id`, `part_no`, `object_key`, `byte_size`, checksum, UNIQUE `(job_id,part_no)` |
| `gallery_access_sessions` | `id`, `gallery_id`, `token_hash`, `access_version`, `expires_at`, `created_at`; optional DB-backed sessions |
| `gallery_events` | `id`, `gallery_id`, `event_type`, `media_id NULL`, `anonymous_session_hash`, `window_bucket`, `bytes_served`, `occurred_at`, uniqueness/idempotency keys |
| `plans` | `id`, `monthly_fee_cents`, `storage_included_gb_month`, `delivery_included_gb`, `max_galleries`, `max_storage_bytes`, `branding_visible`, rate version |
| `billing_accounts` | `user_id PK`, `stripe_customer_id UNIQUE`, `stripe_subscription_id NULL`, `status`, `spend_cap_micro_usd`, warning_thresholds, billing_period_start/end, timestamps |
| `usage_ledger` | `id`, `account_id`, `metric`, `quantity_micro_units BIGINT`, `unit`, `source_id`, `event_time`, `period_start`, `rating_version`, `estimated_cost_micro_usd`; UNIQUE `(metric,source_id)` where appropriate |
| `billing_exports` | `id`, `billing_account_id`, `ledger_cursor`, `stripe_event_id`, `status`, `attempt_count`, `created_at`; UNIQUE Stripe idempotency |
| `job_outbox` | `id`, `event_name`, `aggregate_id`, `payload JSONB`, `processed_at`, `attempt_count`, timestamps |
| `provider_webhook_events` | `provider`, `provider_event_id`, `received_at`, `handled_at`, `status`, UNIQUE `(provider,provider_event_id)` |

Indexes: `(galleries.owner_id, updated_at DESC)`, `(media.gallery_id, sort_key)`, `(media.gallery_id,status)`, `(gallery_events.gallery_id,occurred_at)`, `(usage_ledger.account_id,period_start,metric)`, `(guest_sessions.expires_at)`, `(archive_jobs.status,created_at)`; partial indexes for active records. Keep db migrations versioned and reversible where feasible. RLS for owner-facing tables; service-only ingestion, billing and gateway-sensitive tables never exposed by browser Supabase clients.

## 9. Pricing, quotas, and billing

### 9.1 Confirmed commercial structure

- Free with no card; intended one or two galleries, 1 GB limit and branding.
- Pro costs **$2 USD/month** base fee (confirmed); small allowance; metered storage and delivered GB overages; visible invoice, alerts and configurable spend cap. Any paid account removes gallery branding.
- Full Stripe paid subscriptions and simplified metering live in v1; video-processing meter launches only with v1.1.
- No auto-billing free users. Upgrade through hosted Stripe Checkout; manage payment method/invoices via Stripe Billing Portal.

### 9.2 Proposed **launch rate card** — requires operator margin validation before going live

| Metric | Free | Pro (USD) |
|---|---|---|
| Base subscription | $0 | **$2.00/month**, confirmed |
| Active galleries | **2** max | Unlimited subject to fair use |
| Included stored content | **1 GB total hard cap** | **2 GB-month per billing period** |
| Included delivery | **3 GB/month hard cap for Free** (Proposed) | **5 GB/month** |
| Storage above included | Not permitted | **$0.10 per GB-month** (Proposed) |
| Media delivery above included | Not permitted | **$0.03 per GB served** (Proposed) |
| Photo processing | Included, fair use | Included, fair use |
| Video processing | Not in v1 | Define for v1.1 after provider choice |
| Branding | Discreet Lumra badge | None |

**Caveat:** R2 Standard currently bills stored GB-months and operations but does not bill internet egress as a separate fee. The Lumra delivery charge is a **product price** for measured delivery, not a pass-through of a Cloudflare bandwidth invoice. Cloudflare read/request and Worker execution costs, Stripe's low-ticket processing economics, archive CPU, anti-abuse costs, taxes, and support must be included in margin modeling. If unit economics are unacceptable, adjust proposed allowances/rates, not the user-confirmed $2 base, unless the product owner approves. The model needs billing/receipt/tax analysis before launch.

**Billing units:** decimal GB = 1,000,000,000 bytes. Stored usage integrated over time: GB-month = byte-seconds / (1e9 * 30 * 86,400) for a normalized 30-day rate, clearly disclosed; billing-period-day conventions determined by rate card version. Delivery metered from actual authorized response body bytes successfully transmitted when obtainable, excluding 304 responses and internally generated egress; document approximations if gateway can't observe completed transfer exactly. Deduplicate retries without suppressing legitimate repeated downloads. Estimate current usage every few minutes; reconcile Stripe exports daily and at invoice close.

### 9.3 Provisional monthly bill example

Pro creator uses average 12 GB-month stored and 45 GB of data delivered: `$2.00 + (12 - 2)×$0.10 + (45 - 5)×$0.03 = $4.20` before applicable tax. Values illustrative, price settings live in versioned database/config and surfaced before upgrade. No hidden minimum beyond subscription.

### 9.4 Spending safeguards and overdue policy

- Set default **Pro spending cap of $10/month in overages** (Proposed; base subscription and taxes not counted), adjustable from $0 to a platform maximum; show cap and remaining estimate before large upload initiation. Send alerts at 50%, 80%, and 100% of configured cap with dedupe.
- Reserve conservative estimated cost before new uploads/archive requests; if cap exceeded, reject them with actionable UI. Usage readings lag, so maintain a small defensive provider-side abuse throttle and pause new billable delivery above cap. **Do not promise a perfect hard billing stop for already-started transfers**, and clearly disclose a maximum permitted reconciliation tolerance. An operational safety cutoff must also prevent uncontrolled download egress for galleries, which may temporarily show a bandwidth-limit notice.
- Free: 1 GB stored hard cap plus proposed 3 GB monthly delivery cap; block uploads/downloads that would require unbilled overages. On hitting cap, present graceful "temporarily unavailable" page, not HTTP 500.
- `past_due`: immediately stop uploads/new archive creation; continue existing access for **7 days** (Proposed), then suspend public delivery while preserving media for **30 further days** (Proposed); notify at transitions. Never auto-delete solely because a card fails without explicit policy and notice.
- Delivery meter includes previews and originals, preventing unbounded cost from high-traffic public links. Bots/rate limits apply to anonymous galleries.

### 9.5 Stripe implementation contract

Use Stripe Checkout subscription for $2 base, customer portal, invoice receipts, webhooks verified against raw request body; dedupe by Stripe event ID. Provision entitlements from **confirmed** webhook state, not redirect query parameters. Internal ledger updated first; periodic usage exports to Stripe meter events or invoice items using stable idempotency keys. Stripe meter events are asynchronous; never use Stripe aggregated usage as a real-time spending-cap oracle. Maintain internal invoice reconciliation report and alert on mismatches. Money calculations use integer units, not JS floating point.

## 10. HTTP/API specification v1

All authenticated mutation endpoints require server-validated Supabase session, CSRF protections where relevant, and `Idempotency-Key` for retryable creates. Responses use `application/json` with `{data, error, requestId}`; errors shaped `{code,message,retryable,details?}`. Validate with Zod, infer TypeScript types; cursor-pagination for list endpoints; 401 unauthenticated, 403 unauthorized, 404 concealed existence, 409 conflict, 413 too large, 422 validation, 429 rate limited.

| Method | Endpoint | Authorization | Request / result |
|---|---|---|---|
| POST | `/api/v1/guest/drafts` | guest rate limited | `{}` → `{galleryId,draftExpiresAt}`; set guest cookie |
| GET | `/api/v1/guest/drafts/current` | guest cookie | draft/gallery/upload states |
| POST | `/api/v1/guest/drafts/claim` | guest cookie + auth | `{galleryId}` → authenticated owner; atomic |
| POST | `/api/v1/galleries` | auth | `{title?}` → gallery metadata |
| GET | `/api/v1/galleries` | auth | `cursor,limit` → owner list |
| GET/PATCH/DELETE | `/api/v1/galleries/{id}` | owner | detail / validated patch / async delete ack |
| POST | `/api/v1/galleries/{id}/publish` | owner | `{expiresAt?,password?}` → `slug,shareUrl` immediately |
| POST | `/api/v1/galleries/{id}/upload-intents` | owner or guest | `{filename,mime,size,clientId}` → mediaId, intentId, parts configuration |
| POST | `/api/v1/uploads/{id}/parts/sign` | intent authorized | `{partNumbers:[...]}` → narrowly scoped signed PUT URLs |
| GET | `/api/v1/uploads/{id}` | intent authorized | state, completed part list (no credentials) |
| POST | `/api/v1/uploads/{id}/complete` | intent authorized | `{parts:[{number,etag}],checksum?}` → uploaded/processing |
| POST | `/api/v1/uploads/{id}/abort` | intent authorized | idempotent abort |
| PATCH | `/api/v1/galleries/{id}/media/order` | owner | `{orderedIds:[...]}` → updated revision |
| DELETE | `/api/v1/galleries/{id}/media/{mediaId}` | owner | revoke item + enqueue cleanup |
| GET | `/api/v1/public/galleries/{slug}` | public or access session | title/cover/ready+placeholder items, gated details |
| POST | `/api/v1/public/galleries/{slug}/unlock` | public rate limited | `{password}` → gallery HttpOnly access cookie |
| POST | `/api/v1/public/galleries/{slug}/media-tokens` | permitted viewer | `{mediaIds,action}` → expiring gateway URLs |
| POST | `/api/v1/public/galleries/{slug}/archives` | permitted viewer | `{mediaIds?}` → job ID / reused job |
| GET | `/api/v1/public/archives/{jobId}` | permitted viewer | progress + part download URLs when ready |
| POST | `/api/v1/analytics/events` | viewer permitted, rate limited | bounded view event |
| GET | `/api/v1/galleries/{id}/analytics` | owner | aggregated counts |
| GET/PATCH | `/api/v1/billing/usage` | owner | usage summary / spending cap (split PATCH endpoint in implementation) |
| POST | `/api/v1/billing/checkout` | auth | Stripe Checkout URL |
| POST | `/api/v1/billing/portal` | auth | Stripe portal URL |
| POST | `/api/v1/webhooks/stripe` | signed provider | raw webhook payload, idempotent handler |
| GET | `/api/health` | operator probe | sanitized liveness, no secrets |

**Representative contracts:**

```ts
export type MediaStatus =
  | 'reserved' | 'uploading' | 'uploaded' | 'processing'
  | 'ready' | 'failed' | 'deleting' | 'deleted';

export type GalleryVisibility = 'draft' | 'published' | 'deleted';

export interface GalleryDTO {
  id: string;
  slug: string;
  title: string;
  status: GalleryVisibility;
  expiresAt: string | null;
  coverMediaId: string | null;
  itemCount: number;
  contentVersion: number;
  updatedAt: string;
}

export interface UploadIntentRequest {
  filename: string;
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';
  size: number; // integer bytes, <= 50_000_000
  clientId: string; // UUID per client file, stable across retries
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

**Concurrency:** upload reservation checks remaining bytes and file-count atomically; publication can race upload processing; deleting gallery wins over pending processing and queue workers must check `deleted_at`/content_version before writing final data; changing password revokes media tokens. Archive job binds `content_version` and must fail/recreate if gallery changed during build rather than silently serving stale/deleted media.

## 11. Security and abuse test matrix

| Scenario | Expected behavior |
|---|---|
| Guess R2 object key | Private bucket denies anonymous read |
| Guess secret media URL after token expiry | 401/403; no byte delivery |
| Gallery password changed | Previously unlocked session no longer mints media tokens; gateway revokes cached access version rapidly |
| Gallery deleted during in-flight download | New requests fail immediately; already-open response may finish only as explicitly documented; no new byte ranges authorized |
| Expired gallery | Public metadata and media access blocked; owner can edit expiry |
| Guest claims draft from another session | Denied without guest capability, even if logged in |
| Guest concurrently reserves 21 files | Exactly <=20 reservations accepted, atomic conditional transaction |
| Malicious file extension / image bomb | Rejected and cleaned; processing sandbox not crashed |
| Replay Stripe webhook | Idempotent, no extra entitlement or usage charge |
| Hitting paid spending cap | New costs prevented/limited, consistent user error and operational guardrails |
| Archive contains `../` filename | Sanitized path; archive unzip cannot escape target |
| Bot scrapes gallery | Rate limits, circuit breakers, no expensive unbounded origin costs |

## 12. Nonfunctional requirements

**Accessibility:** keyboard-first controls; focus trap/recovery in lightbox; clear loading and error announcements (`aria-live` appropriately throttled); alt text is filename-based or neutral description if unknown (do not claim AI descriptions); color contrast accessible; no essential information conveyed only by motion/color.

**Performance:** lazy loaded derivatives; `srcset`, intrinsic sizes, responsive grid calculations; prefetch adjacent lightbox image conservatively; no original bytes in gallery viewing; virtualization and windowing for 2,000-item lists; cache immutable derivative bytes by keyed version with authorization performed before edge-cache retrieval.

**Reliability:** queue retry and DLQ; nightly reconciliation; database backup restores exercised monthly; failed upload shows recovery action; no silent data loss. Periodic expiration/garbage collection job; shipping dashboard for queue lag, orphan objects, processing failures, media bytes, Stripe mismatch.

**Observability:** structured JSON logs with request IDs, trace IDs spanning Next.js→queues→workers, sanitized error payloads, Sentry exception source maps, alerts on payment webhook failures, upload failures, processor failure rate, backlog, storage runaway, unexpected delivery.

**Costs:** avoid serverful always-on machines when idle; bound maximum derived images and archive processing; set Cloudflare/Vercel/Stripe budget alerts and record actual versus billed consumption weekly in public beta.

**Documentation:** ADRs for major architectural decisions; runbooks; reproducible local development and seed fixtures; API compatibility constraints; versioned config, no inline production secrets.

## 13. Repository structure and agent engineering conventions

```text
lumra/
  apps/
    web/                  # Next.js App Router (Vercel)
    media-gateway/        # Cloudflare Worker for authorized R2 delivery
    worker/               # queue consumers / job coordinators
  packages/
    db/                   # SQL migrations, types, repo/query layer
    contracts/            # Zod request/response/event contracts
    domain/               # pure business logic, state machines, quotas
    billing/              # rating/ledger/stripe adapter, deterministic tests
    media/                # storage adapter, metadata/derivative interfaces
    ui/                   # shared components, design tokens
    config/               # env schemas, typed rate card and feature flags
  infra/
    cloudflare/           # wrangler envs, queues, bucket config
    supabase/             # migrations, RLS, seed and tests
    vercel/               # environment notes
  tests/
    e2e/                  # Playwright full journeys
    security/             # auth/rate-limit/permission and token tests
    performance/          # k6/Artillery or equivalent test harness
  docs/
    PRD.md                # this specification
    ADR/                  # architectural decision records
    RUNBOOKS.md
    BILLING.md
    RELEASE.md
  .github/workflows/      # CI, dependency scanning, preview deployment
```

**Proposed tools:** pnpm workspaces + Turborepo, TypeScript strict mode, Next.js App Router, Tailwind CSS + accessible headless component primitives, Zod, Supabase client/server SDKs, Drizzle ORM or SQL-first generated types (choose one ADR), Vitest, Playwright, ESLint/Prettier, Sentry. Agent must not switch framework/storage/auth stack without PRD change approval.

**Agent working agreement:** one task = one bounded PR with tests and doc changes; no duplicated business logic between web and Worker; schema/API contract changes first; run `typecheck`, lint, unit/integration/e2e relevant suites; use test fixtures and seeded data; all state changing endpoints must have an authorization test; all metered actions need ledger coverage; all DB changes include migration + rollback/forward-fix note; remove feature flags only when stable. No mock payment status in production.

## 14. Implementation sequence (agent-sized milestones)

| Epic | Task IDs and acceptance gate | Depends on |
|---|---|---|
| P0 Foundation | T01 monorepo, CI, formatting, env validators; T02 Supabase schema/RLS; T03 deployed Next.js shell/design tokens; T04 metrics/logging + health probes | None |
| P1 Identity + drafts | T05 email OTP/magic link; T06 guest cookie, draft TTL, quota atomic reservations; T07 claim workflow incl interrupted auth; T08 authenticated dashboard | P0 |
| P2 Image upload | T09 private R2 + CORS + storage keys; T10 multipart upload intent/sign/complete/resume; T11 photo content validation and metadata; T12 derivative pipeline with retries/DLQ; T13 reconciler/cleanup; T14 upload UX | P1 |
| P3 Gallery delivery | T15 gallery editor CRUD/order/cover; T16 publish-during-upload and placeholders; T17 public hero + justified virtualized grid; T18 lightbox/mobile UX; T19 gallery password/expiration; T20 private gateway/tokens/access revocation; T21 share/QR/native | P2 |
| P4 Downloads + analytics | T22 single original; T23 multi-select; T24 streaming background archives/parts; T25 archive progress and TTL; T26 views/download counts and list metadata | P3 |
| P5 Billing | T27 rate card, internal metering and reservation logic; T28 Free caps; T29 Checkout/Portal/webhooks; T30 subscription entitlements; T31 usage export/invoices/reconciliation; T32 spending caps/alerts; T33 payment-failure states | P0, P3 |
| P6 Hardening + launch | T34 threat-model review, adversarial test matrix; T35 performance 2,000 item gallery; T36 mobile/device tests; T37 backups/restore/drills; T38 monitored staging; T39 production Stripe + Cloudflare smoke tests; T40 public launch gate | P3–P5 |
| v1.1 Video | V01 provider decision; V02 original R2 upload + managed transcoding intake; V03 secure adaptive playback; V04 poster media + video viewer; V05 processing meter/quote; V06 integration/billing/security tests | Stable v1 |

**Execution dependency notes:** P5 rate-card/quotas must integrate with P2 upload admission before public release. Secure gateway T20 must be completed before any publicly accessible preview or download. P3 demo fixtures may use mocked provider objects only in local/staging environments.

### 14.1 Mandatory task completion definition

Every task must include: functional implementation; typed interface and input validation; authorization and error handling; component-level tests; documentation; observability hooks for async/provider logic; explicit manual QA script; merged CI passing. No task is “done” with only a UI mock.

### 14.2 Critical end-to-end acceptance scenarios

1. Guest creates draft, uploads 10 HEIC/JPEG photos, leaves, refreshes in same browser, resumes, signs in at Publish and copies working link.
2. 21st guest upload or upload crossing 250 MB prompts authentication before reservation; earlier files preserved.
3. Link is usable before upload completes; recipient sees pending placeholders then ready photos without refreshing (polling acceptable; WebSockets not required).
4. Password-protected gallery refuses direct media URLs before unlock; password change revokes access; expiry blocks viewing and downloads.
5. Mobile recipient opens gallery, lightbox-swipes, selects three items, receives original-files ZIP; 2,000 items remain navigable.
6. Creator changes ordering and cover after publication; published URL remains stable.
7. Free creator hitting quotas cannot accrue charges; paid creator sees accurate usage, alerts, and cap behavior.
8. Stripe checkout success webhook activates Pro exactly once; failed payment blocks new uploads with grace policy.
9. Delete gallery during upload and archive build; immediate public access denial and eventual R2 object cleanup confirmed.
10. Synthetic malware/invalid files, simulated provider outages, upload retry after network drop, queue poison messages, and repeated webhook deliveries handled gracefully.

## 15. Release, monitoring and rollout

**Development:** local Next.js + Supabase local instance or dedicated dev project; R2 development bucket; Stripe test mode; fake email inbox; Cloudflare Worker dev environment. Every PR previews UI on Vercel with synthetic-only media. Never point preview deployments at production R2 or Stripe secrets.

**Staging:** production-like separate Supabase project, R2 buckets, Workers routes and Stripe test customer accounts. Run full Playwright critical flows, accessibility check, link revocation test, backup restore smoke test, responsive screenshots, and load tests.

**Production release:** set DNS/domain/TLS and custom media domain; verify email sender SPF/DKIM/DMARC and auth redirect allowlist; configure CORS and HTTP response security headers; provision Stripe live prices and signed webhook secret; perform finance/tax/terms/privacy review; verify pricing page values match config; allow limited initial signup cohort if needed for operational safety (public site remains accessible); monitor daily for first month.

**Rollback:** deploy previous Next.js and Worker revisions; run forward-compatible DB migrations before new code; rollback never removes rows or stops worker consumers mid-job without draining; disable upload/paid checkout through server-controlled feature flags if reconciliation fails; preserve existing galleries in read-only mode on severe incident. Payment bugs: disable checkout/usage export, audit ledger, correct invoices with explicit process.

**Dashboard alerts (Proposed):** P1 unauthorized data disclosure/payment duplication = immediate incident; P2 upload finalize error >2% / gateway 5xx >1% 10 minutes / queue backlog >30 minutes / Stripe webhook >15 minutes unresolved; P3 drift between billed and provider consumption >10% across a daily window. Set runbooks and operator contact before launch.

## 16. v1.1 video specification (deferred, prepared but not built in v1)

- Formats MP4/MOV up to **2,000,000,000 bytes per file**; transcoding for browser-compatible adaptive playback; video poster in gallery; preserve exact uploaded video in R2 for downloads; managed service candidate Cloudflare Stream or Mux after cost/security analysis.
- Choose either dual upload (R2 + managed service) or server-to-server ingest/copy; pick approach based on provider source-ingest features, egress cost, availability, and resumability. Do not require users to upload video twice manually.
- Video states distinguish original upload complete, provider processing, playable, failed, and original-download ready. Gallery publication still independent.
- Secure playback must not leak permanent public manifest or segment URLs for password-protected galleries; provider signing/token scheme required.
- Meter processing according to actual provider-billable usage or predictable processed minutes, show estimated charge before acceptance when applicable, and apply spending-cap reservations; publish versioned rate card before launch.
- Test iPhone MOV/HEVC, common H.264/H.265 input, portrait video, audio sync, poster quality, 2 GB network interruption, playback on iOS Safari/Chrome/Firefox, expired gallery token, abusive streaming bandwidth.

## 17. Risk register and change control

| Risk | Impact / mitigation | Owner decision boundary |
|---|---|---|
| $2 subscription margin | Stripe fees and support may exceed base contribution. Model gross margin with expected media usage, fees and taxes. | Reprice proposed allowances/overages without altering base fee unless approved. |
| Worker secure media/cache semantics | Incorrect caching bypasses revocation. Validate gateway in security tests before production. | No public R2 fallback. |
| Multipart edge cases | Abandoned objects cost storage; per-part resume consistency errors. | Job reconciliation + TTL. |
| HEIC decoding and ICC | Native dependency and color inaccuracies. | Dedicated container processor, golden-image fixtures. |
| ZIP for 2,000 high-res files | Runtime/memory constraints. | Split archives, background streaming, bounded job work. |
| Billing event lag | Cap overshoot/incorrect invoice. | Internal realtime ledger + reservations, daily reconciliation. |
| Public link abuse | High delivery costs even with low user count. | Rate limits, cap guards, view throttles. |
| Privacy/rights | Photos may contain sensitive personal data. | Clear consent/terms, deletion, retention, minimal telemetry. |

**Commercial settings tagged Proposed:** free active galleries=2; free monthly delivery=3 GB; Pro included storage=2 GB-month; Pro included delivery=5 GB; storage overage=$0.10/GB-month; delivery overage=$0.03/GB; Pro default overage cap=$10; cap grace/tolerance policy; past-due grace=7 days, retention=30 days; archive partitions 500 items/2 GB; measured performance thresholds. These are defaults to validate with unit-economics and usability tests, not a claim of user approval.

**Architecture decision records required:** ADR-001 private media gateway vs presigned URLs; ADR-002 image processor/container/queue; ADR-003 ZIP implementation and partition sizes; ADR-004 billing rating/Stripe meter mapping; ADR-005 RLS and guest claim security; ADR-006 video provider decision before v1.1. None should trigger a new product interview unless contradicting confirmed user choices.

## 18. Source references and provider caveats (verified October 2026)

- Cloudflare R2 pricing: <https://developers.cloudflare.com/r2/pricing/>. Standard storage listed at $0.015/GB-month, operations separate, internet egress free as of 20 Oct 2026. Recheck before pricing launch.
- Cloudflare R2 presigned URLs: <https://developers.cloudflare.com/r2/api/s3/presigned-urls/>. S3 API domain only; URLs are bearer tokens; custom domains unsupported for presigned URLs.
- R2 Workers API: <https://developers.cloudflare.com/r2/get-started/workers-api/>. R2 binding permits private-object access inside Worker; application must enforce authorization.
- Vercel Function request-body limit: <https://vercel.com/docs/functions/limitations>. 4.5 MB, therefore use direct client-to-R2 upload.
- Supabase passwordless auth: <https://supabase.com/docs/guides/auth/auth-email-passwordless>. Email OTP/magic links supported; configured redirect allowlists and delivery limits apply.
- Stripe usage meters: <https://docs.stripe.com/api/events/retrieve>. Meter events are processed asynchronously; do not treat as real-time source for spending caps.

---

**Final implementation instruction for coding agents:** Start with P0/T01 and follow dependency order. Before implementing any task, inspect `docs/PRD.md`, the relevant contracts, and ADRs. If a conflict appears, prioritize explicitly confirmed requirements, record a concise ADR and add a regression test. Do not add video to v1, do not introduce unapproved feature scope, and do not send large media through Vercel functions. Production is gated by security, end-to-end, billing, and restore tests, not by UI completion alone.
