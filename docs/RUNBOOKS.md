# Runbooks

Filled in as the relevant systems land (T13, T38). Each runbook: symptom → dashboards/queries → mitigation → follow-up.

- [x] [Queue backlog > 30 min / DLQ growth (T12)](#queue-backlog--dead-letter-queue)
- [ ] Upload finalize error rate > 2% (T10)
- [x] [Gallery access state out of sync / gateway 403s (T20)](#gallery-access-state-kv-sync-t20)
- [x] [Deleted media / galleries not purged from R2 (T13)](#physical-deletion-purge-t13)
- [ ] Media gateway 5xx > 1% for 10 min (T20)
- [ ] Stripe webhook unresolved > 15 min (T29)
- [ ] Billed vs provider consumption drift > 10% (T31)
- [ ] Suspected unauthorized disclosure — P1 incident (T34)
- [ ] Database restore from PITR (T37)
- [ ] Disable uploads / checkout via feature flag; read-only mode (T38)

## Auth and guest claim (T05/T07)

See [AUTH.md](AUTH.md) for the flow, the hosted Supabase email-template and redirect setup, and
the manual QA script.

- Users report "no code in the email" or "link only works on one device": the hosted project is
  still using Supabase's default templates. Paste `infra/supabase/templates/magic_link.html` (AUTH.md).
- Claims refused: grep logs for `guest claim refused` and its `reason`
  (`no_capability` = a different browser, `session_expired`, `capability_mismatch`). The client
  always sees a 404.

## Gallery access state (KV sync, T20)

**Flow** (ADR-001): any change to a gallery's access-relevant fields (publish, password, expiry,
suspension, delete) calls `enqueueAccessStateSync` in the same transaction → `job_outbox` row
`gallery.access_changed` → worker relay → `lumra-jobs-<env>` → handler
`apps/worker/src/handlers/access-state.ts` re-reads the gallery (+ owner billing) from Postgres
and writes `gallery:{id}` in the `ACCESS_STATE` KV namespace. `gallery.delete` writes a tombstone
(`deleted: true` → gateway 404). Drafts write nothing (missing doc → gateway 404). Handler is
idempotent: duplicates/reordering converge on the current DB state.

**Setup (T38):** create the namespace once per env (`wrangler kv namespace create
lumra-access-state-<env>`) and put the **same** `id` under `ACCESS_STATE` in both
`apps/worker/wrangler.jsonc` and `apps/media-gateway/wrangler.jsonc`. Without explicit ids
wrangler auto-provisions a separate namespace per Worker and the gateway 404s everything.

**Symptoms:** recipients see broken images (gateway 403 `revoked` / 404) although the gallery page
renders; or a changed password still serves media beyond ~1 min.

1. Check the outbox: `select event_name, attempt_count, last_error, available_at from job_outbox
where aggregate_id = '<gallery id>' and processed_at is null;` and the DLQ for
   `gallery.access_changed` messages (see below).
2. Compare `galleries.access_version` with the KV doc:
   `wrangler kv key get --binding ACCESS_STATE "gallery:<id>" [--env …]`. Higher in Postgres =
   KV lagging (403 until fixed); `deleted: true` while the gallery is live = stale tombstone.
3. **Fix one gallery:** insert a fresh outbox row (what `enqueueAccessStateSync` writes) or replay
   the DLQ message. **Fix all:** run `reconcileAccessStates` (exported from the same module;
   T13 schedules it) — it rewrites every published/deleted gallery and also applies time-based
   billing suspension (past-due grace elapsing).
4. KV is eventually consistent (~60 s across edge locations); a correct write that is "not yet
   visible" elsewhere resolves on its own. New tokens are never minted for a locked/expired
   gallery because the web app checks Postgres directly.

**Token minting (T20):** the web signs with the first `MEDIA_TOKEN_SECRET` entry. The public
gallery payload carries preview URLs for the first 48 items + hero; the client mints the rest via
`POST /api/v1/public/galleries/{slug}/media-tokens` (≤ 100 ids/call, per-IP rate limit
`publicMediaTokens`). A spike of `rate_limited` on that route usually means a scraper — see
`RATE_LIMITS` in `@lumra/config`.

**Password brute force (T19):** `galleryUnlock` (per IP, 10 / 15 min, Turnstile above 5 when
configured) and `galleryUnlockPerGallery` (300 / 15 min across all IPs). Logs:
`rate limited` with `rule`. Sessions live in `gallery_access_sessions` (token hash only); revoke
all sessions of a gallery by bumping `galleries.access_version` (+ enqueue the KV sync).

## Queue backlog / dead-letter queue

**Pipeline** (ADR-002): web finalize writes `job_outbox` and kicks the worker
(`POST /internal/relay`, see below) → the worker publishes due rows to `lumra-jobs-<env>`; the cron
(`* * * * *`, relays for ≤ 55 s per tick) is the fallback → `media.uploaded` consumer (batches of
≤ 4, run concurrently on distinct processor slots) → image-processor container → derivatives in R2

- `media_variants`. Failed jobs retry with exponential backoff (20 s … 15 min); jobs that hit a
  deadline retry after 5 s, 15 s, 60 s, 180 s, 600 s. After `max_retries: 5` they land in
  `lumra-jobs-dlq-<env>`. Poison (schema-invalid) messages are logged as `invalid queue message`
  and acked, never retried. Valid messages whose type has no handler (e.g. `guest.expire` today)
  are logged as `no handler registered; message dropped` (error, with `type` and `dedupeKey`, plus a
  Sentry event) and acked — retrying could never succeed and only parked them in the DLQ, which has
  no consumer. Once the handler ships, re-queue them from the outbox:
  `update public.job_outbox set processed_at = null, available_at = now() where event_name = '<type>' and …;`

**Deadlines**: nothing in the worker may wait forever. Postgres: `connect_timeout` 5 s, idle 2 s,
`fetch_types` off (direct connections also get `statement_timeout` 15 s; behind Hyperdrive the
worker uses prepared statements and relies on its own deadlines). Each DB call ≤ 15 s, each R2 call
≤ 20 s, each job ≤ 120 s, each relay pass ≤ 20 s, each cron tick ≤ 55 s, `sql.end` ≤ 2 s. A fired
deadline logs `deadline exceeded` (warn) with `step`, `limitMs` and the step timings so far.

**Symptoms**: oldest-message age on `lumra-jobs-*` > 30 min; DLQ message count growing; media stuck
in `uploaded`/`processing`; unprocessed `job_outbox` rows. Workers Observability showing
invocations with outcome `exceededWallTime` (≈ 900 s) on the cron or queue handler means a call
hung without a deadline — that is a bug since the stall fix; look for the last log line of that
invocation.

**Look first**

1. Worker logs (Workers Observability, `service: "worker"`): `job failed` entries grouped by
   `type`/`error`; `deadline exceeded` grouped by `step` (`db.*` ⇒ Postgres/Hyperdrive,
   `r2.*`, `processor.process`, `relay pass (cron|kick)`); `outbox publish failed`;
   `invalid outbox row`. Healthy traffic shows `cron tick started/finished` every minute,
   `relay pass` with `claimed`/`published`/`ms`, and per job `job started` → `job finished` with
   `steps` (`db.getForProcessing`, `r2.originals.get`, `processor.process`, `r2.derivatives.put`,
   `db.complete`, in ms).
2. Processor logs (`service: "image-processor"`): `process failed` with `code`. A burst of
   `processor_unavailable` means the image lost its HEVC decoder (bad deploy; roll back the
   container). `processor_busy` means too few instances: raise `max_instances` /
   `PROCESSOR_POOL_SIZE`.
3. Outbox lag (service role / SQL editor):

   ```sql
   select count(*) as due, min(available_at) as oldest, max(attempt_count) as max_attempts
   from public.job_outbox where processed_at is null and available_at <= now();
   select id, event_name, attempt_count, last_error from public.job_outbox
   where processed_at is null and attempt_count > 0 order by attempt_count desc limit 20;
   ```

4. Stuck media: `select status, count(*) from public.media where status in ('uploaded','processing')
and updated_at < now() - interval '30 minutes' group by 1;` (T13 re-enqueues these).

**Mitigate**

- Transient outage (processor, R2, Postgres): fix the cause, then replay the DLQ. Replays are
  safe: the consumer is idempotent (`ready`/`failed`/deleted media are acked without work).
  ```sh
  # once per environment
  pnpm --filter @lumra/worker exec wrangler queues consumer http add lumra-jobs-dlq-<env>
  # inspect without consuming
  CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
    node apps/worker/scripts/replay-dlq.mjs --from lumra-jobs-dlq-<env> --to lumra-jobs-<env> --dry-run
  # replay (optionally --type media.uploaded --limit 500)
  CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
    node apps/worker/scripts/replay-dlq.mjs --from lumra-jobs-dlq-<env> --to lumra-jobs-<env>
  ```
- Kick the relay by hand (publishes due outbox rows now instead of waiting for the cron; safe to
  repeat — it only runs `relayOutbox`, rows are claimed with `SKIP LOCKED`):
  ```sh
  curl -fsS -X POST -H "Authorization: Bearer $WORKER_KICK_SECRET" \
    https://<worker-host>/internal/relay   # 202 accepted | 401 bad token | 503 secret not set
  ```
  The web app sends the same request after every finalize when `WORKER_URL` and
  `WORKER_KICK_SECRET` are set on Vercel; the worker needs the same `WORKER_KICK_SECRET`
  (`wrangler secret put WORKER_KICK_SECRET --env production`, ≥ 32 characters). Kick failures
  show as `worker relay kick failed/rejected` (warn) in web logs and cost only latency.
- Media stuck in `uploaded` whose outbox row is already `processed_at` (message lost or DLQ'd):
  re-enqueue by resetting the row, then kick:
  `update public.job_outbox set processed_at = null, available_at = now() where event_name = 'media.uploaded' and aggregate_id in (select id from public.media where status in ('uploaded','processing') and updated_at < now() - interval '15 minutes');`
- Outbox rows failing to publish: `last_error` says why; they retry on their own with backoff
  (capped at 1 h). To force an immediate retry after a fix:
  `update public.job_outbox set available_at = now() where processed_at is null and attempt_count > 0;`
- `invalid outbox payload` rows are producer bugs: fix the writer, then correct or delete the row.
- A single file repeatedly timing out or crashing the processor ends in the DLQ; do not replay it
  blindly. Mark it failed instead:
  `update public.media set status = 'failed', failure_code = 'processing_timeout' where id = '…' and status = 'processing';`

**Follow-up**: record the incident, the replay counts printed by the script, and whether alert
thresholds need tuning.

## Physical deletion purge (T13)

**Pipeline** (FR-G06): deleting a photo (or aborting an upload) sets media `deleting` + `deleted_at`
and writes `media.delete:{mediaId}`; deleting a gallery sets it `deleted` and writes
`gallery.access_changed` + `gallery.delete:{galleryId}`. The worker's `media.delete` handler deletes
the original (`ORIGINALS`, `media.original_key`) and every variant (`DERIVATIVES`,
`media_variants.object_key`), then marks the row `deleted` (variant rows are kept). `gallery.delete`
writes the KV tombstone, then purges every media of the gallery in batches of 200, everything left
under `derivatives/{galleryId}/` and `archives/{galleryId}/` (`ARCHIVES`), and marks its
`archive_jobs` `deleted`; a run that exceeds 90 s retries and continues where it stopped. Marking
`deleted` frees plan admission (`deleting` media with a completed upload still count).

**Backstop sweep** (`*/15 * * * *`, ≤ 50 s per tick): media soft-deleted more than 1 h ago and not
`deleted` (index `media_purge_pending_idx`), and galleries deleted more than 1 h ago that still have
non-`deleted` media or archive jobs (10 per tick, oldest first), are purged the same way. Logs:
`deletion sweep finished` with `galleries`, `purged`, `objectKeys`, `invalidKeys`,
`galleriesFailed`, `mediaBatchesFailed`, `budgetExhausted`; per job `media purge finished` /
`gallery purge finished`. Logs carry ids and counts only, never object keys.

**Symptoms**: rows in `deleting` for more than a few hours; `deletion sweep finished` with
`galleriesFailed`/`mediaBatchesFailed` > 0 or `budgetExhausted: true` on consecutive ticks;
`purge refused: … is not deleted` (a message named live data — a producer bug).

```sql
select count(*), min(deleted_at) from public.media where deleted_at is not null and status <> 'deleted';
select g.id, g.deleted_at from public.galleries g where g.deleted_at is not null
  and exists (select 1 from public.media m where m.gallery_id = g.id and m.status <> 'deleted');
```

**Mitigate**: R2/Postgres outage → nothing to do; the sweep catches up once healthy (the purge is
idempotent and safe to run concurrently). `purge skipped invalid object keys` means a stored key
doesn't match the key scheme; those objects are left for the R2 orphan reconcile — inspect the row.

**Gateway window**: the gateway does not check per-media deletion. A media token issued before the
delete (≤ 5 min TTL) can fetch the object only until the purge removes it (normally within a minute
of the delete; the gateway then answers 404 `object_missing`). Gallery deletion is enforced at once
through the KV tombstone and the `access_version` bump.

## Observability (T04)

Shared implementation: `packages/observability` (`@lumra/observability`) — logger, redaction,
request IDs, health payload and Sentry scrubbing. Used by `apps/web`, `apps/media-gateway` and
`apps/worker`.

### Log format

Every event is one JSON line on stdout/stderr (Vercel Runtime Logs, Cloudflare Workers Logs):

| Field                            | Meaning                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `ts`                             | ISO-8601 timestamp                                                                       |
| `level`                          | `debug` \| `info` \| `warn` \| `error` (minimum set by `LOG_LEVEL`, default `info`)      |
| `service`                        | `web`, `media-gateway` or `worker`                                                       |
| `msg`                            | Short, stable message (`request completed`, `job failed`, …)                             |
| `requestId`                      | Request ID (web, gateway); also returned in `x-request-id` and the API envelope          |
| `traceId`                        | Queue jobs: the `requestId` of the request that enqueued the message                     |
| `route`                          | Web: route template, e.g. `GET /api/health` (raw paths are never logged)                 |
| `method`, `status`, `durationMs` | Web request completion line                                                              |
| `type`, `messageId`, `attempt`   | Worker job fields                                                                        |
| `err`                            | `{ name, message, code?, cause? }`; `stack` only at `LOG_LEVEL=debug` outside production |

Redaction runs on every field and on `msg`: values under keys such as `token`, `secret`,
`password`, `authorization`, `cookie`, `signature`, `*key`, `email` are replaced with
`[REDACTED]`; IP keys are truncated (IPv4 → `/24`, IPv6 → `/48`); free text is scanned for
JWTs, bearer credentials, Stripe/Supabase secrets, signed-URL params (`X-Amz-Signature`,
`X-Amz-Credential`, `token`, `code`, …), URL userinfo, emails and IPs. Never bypass the
logger with raw `console.*` for request data.

### Request IDs and tracing

- Inbound `x-request-id` is reused when it is a UUID / safe ID (`[A-Za-z0-9._:-]`, ≤ 64 chars);
  otherwise a UUID is generated. Every web API response carries `x-request-id` and
  `requestId` in the body; support should ask users for it from the error screen.
- Web route handlers are wrapped with `withRoute(name, handler)` (`apps/web/src/lib/route.ts`),
  which logs completion and turns unexpected errors into the standard `internal` 500 envelope.
- Producers stamp queue messages with `withTraceId(message, requestId)`, so worker logs carry
  `traceId` equal to the originating `requestId`.

**Find everything for one request:** search the ID across both fields.

- Vercel → Project → Logs: query `"<requestId>"` (or filter on the `x-request-id` response header).
- Cloudflare → Workers & Pages → `lumra-worker` / `lumra-media-gateway` → Logs
  (`observability.enabled` in `wrangler.jsonc`): JSON fields are indexed, so filter on
  `requestId` / `traceId` equal to the ID, or full-text search `"<id>"`.
- Sentry: search `requestId:<id>` (events are tagged by web, gateway and worker).

### Health probes

`GET /api/health` (web), `GET /health` (media gateway and worker) return only
`{ status: "ok", service, commit? }` with `Cache-Control: no-store`. `commit` is the first
12 characters of `VERCEL_GIT_COMMIT_SHA` (web) or the `COMMIT_SHA` var (Workers, set with
`wrangler deploy --var COMMIT_SHA:$GITHUB_SHA`). The web envelope wraps it in `data`. The
gateway returns 503 when its env is invalid. Point uptime checks at these URLs (T38).

### Sentry setup

Everything is a no-op without a DSN (local dev, CI, preview without secrets); builds never
require Sentry env.

1. Create Sentry projects `lumra-web` (Next.js) and `lumra-workers` (Cloudflare) — or one
   per Worker. In each project's Security & Privacy settings enable **Prevent Storing of IP
   Addresses** and **Data Scrubber** (defence in depth; the SDKs already send
   `sendDefaultPii: false` and scrub via `beforeSend`/`beforeBreadcrumb`).
2. Vercel env (per environment — never reuse production values in preview):

   | Variable                       | Scope         | Purpose                                                           |
   | ------------------------------ | ------------- | ----------------------------------------------------------------- |
   | `SENTRY_DSN`                   | runtime       | Server + Edge SDK                                                 |
   | `NEXT_PUBLIC_SENTRY_DSN`       | build         | Browser SDK (inlined at build time)                               |
   | `SENTRY_ENVIRONMENT`           | runtime       | Optional; defaults to `VERCEL_ENV`                                |
   | `SENTRY_ORG`, `SENTRY_PROJECT` | build         | Source map upload target                                          |
   | `SENTRY_AUTH_TOKEN`            | build, secret | Enables source map upload in `next build`; unset ⇒ upload skipped |

3. Workers: `wrangler secret put SENTRY_DSN` (per `--env`), optional vars
   `SENTRY_ENVIRONMENT`, `LOG_LEVEL`, `COMMIT_SHA`. Both Workers are wrapped with
   `withSentry` from `@sentry/cloudflare` (needs the `nodejs_compat` flag, already set).
4. Worker source maps: `wrangler deploy --outdir dist --upload-source-maps --var COMMIT_SHA:$SHA`, then
   `npx @sentry/cli sourcemaps upload --org $SENTRY_ORG --project $SENTRY_PROJECT --release $SHA dist`
   (only when `SENTRY_AUTH_TOKEN` is set). Wire into the deploy workflow in T38.
5. Verify (T04 acceptance): trigger a test error in each runtime in staging and confirm the
   event shows the `requestId` tag and contains no tokens, emails or full IPs.
