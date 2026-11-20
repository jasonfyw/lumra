# Downloads: "Download all" archives (T24/T25)

Recipients download originals singly (T22, through the media gateway) or all at once as background
ZIP archives. Design and the Worker-vs-container decision: [ADR-003](./ADR/003-zip-archives.md).
Access rules for media URLs: [ADR-001](./ADR/001-private-media-gateway.md).

## Flow

```
/g/{slug}  "Download all"
   │ POST /api/v1/public/galleries/{slug}/archives     (web, authorizes the viewer)
   ▼
archive_jobs (queued) + archive_parts (entries fixed) + job_outbox archive.build   ← one transaction
   │ outbox relay (cron / finalize-style kick) → JOBS queue
   ▼
apps/worker archive.build: R2 originals → STORE ZIP → R2 multipart → temp-archives
   │ archives/{gallery}/{job}/{part}.zip, archive_parts.byte_size, job → ready (expires_at = +24 h)
   ▼
GET /api/v1/public/archives/{jobId} → per-part gateway URLs (action 'archive', ≤ 5 min)   (T25)
```

ZIP bytes never pass through Vercel: the worker reads and writes R2 through bindings, and
recipients download from the media gateway.

## `POST /api/v1/public/galleries/{slug}/archives`

Body `{ mediaIds?: uuid[] }` (omit for "Download all"; a subset is for multi-select). Response
`CreateArchiveResponse` `{ jobId, reused, status, itemCount, partsExpected }` — 201 when a build was
queued, 200 when an existing job was returned. `Cache-Control: private, no-store`.

| Caller / state                                   | Result                                                   |
| ------------------------------------------------ | -------------------------------------------------------- |
| unknown slug, draft, deleted gallery             | 404 `not_found` (indistinguishable)                      |
| expired gallery                                  | 410 `gallery_expired`                                    |
| passworded gallery without a live session at the | 401 `password_required` (wrong password, other gallery's |
| current `access_version`                         | session, or a password change since unlocking)           |
| foreign `Origin`                                 | 403; malformed body 422                                  |
| no ready photos (or none of `mediaIds` ready)    | 409 `conflict` (`no_ready_items`, retryable)             |
| 5 jobs already building for the gallery          | 429 `rate_limited`, `Retry-After: 60`                    |
| more than 20 requests / hour from one IP         | 429 (`publicArchiveCreate`)                              |
| owner past due / canceled (PRD §9.4)             | 403 `quota_exceeded` (`archive_unavailable`; no billing  |
|                                                  | detail is shown to recipients, the reason is logged)     |

Semantics:

- **Content binding.** The job stores the gallery's `content_version`, `access_version` and a
  `source_fingerprint` (SHA-256 of the ordered `mediaId/name` list of ready originals). Only
  `ready`, non-deleted media are included, in display order (`sort_key COLLATE "C", id`).
- **Reuse.** Same gallery + both versions + fingerprint, and the job is `requested/queued/running`,
  or `ready` with ≥ 2 h of its 24 h left → that job is returned. Failed and expired jobs are never
  reused, so "Try again" simply creates a new job.
- **Partitions.** ≤ 500 items and ≤ 2,000,000,000 bytes of originals per part (`ARCHIVE_LIMITS`).
  A 2,000-photo gallery gives ≥ 4 parts. Download names: `{title}.zip` or
  `{title} (part 2 of 4).zip`.
- **Entry names.** User filenames are sanitized to one safe path component (no `../`, separators,
  control/bidi characters or reserved Windows names) and de-duplicated case-insensitively across
  the whole archive with deterministic suffixes: `a.jpg, A.JPG → a.jpg, A (2).JPG`.
- **Passworded galleries.** The response also sets the gallery session cookie on
  `/archive/{jobId}` and `/api/v1/public/archives/{jobId}` (HttpOnly, SameSite=Lax, same expiry), so
  the progress page and status API can re-check the session without the cookie ever being sent to
  other galleries' or archives' paths. The job id itself is an unguessable UUID capability.
- **Concurrency.** Requests for one gallery serialize on a transaction-scoped advisory lock, so a
  double click yields one job; editor writes are not blocked.

## Worker: `archive.build`

`apps/worker/src/handlers/archive-build.ts`, repository `@lumra/db` `createArchiveRepository`.

1. Claim the build lease (`queued → running`, or resume `running`). A live lease held by another
   delivery → retry in 15 min. Terminal jobs (`ready`/`failed`/`expired`) are a no-op ack.
2. Check the gallery (published, not deleted, same `content_version`).
3. For each part not yet complete: verify its media are still deliverable, abort a stale multipart
   upload, stream each original into the ZIP writer and the 8 MiB multipart buffer, complete the
   upload, then record `byte_size`/`completed_at` in a transaction that re-checks the gallery.
   Progress (`progress_pct`, never 100 before ready) is written at most every 2 s.
4. Mark `ready` with `expires_at = now + 24 h` (only if every part is complete and the version still
   matches).

Failures: `content_changed`, `gallery_unavailable`, `original_missing` → `failed` immediately;
other errors are retried by the queue (lease released) and become `build_failed` on the 5th attempt.
Job deadline 14 min (`DEADLINES.archiveJobMs`); the script allows 5 min CPU (`limits.cpu_ms`).

Logs carry job ids, part numbers, counts and sizes — never filenames, keys or URLs.

## Status, progress page and TTL (T25)

`GET /api/v1/public/archives/{jobId}` → `ArchiveStatusResponse` (`packages/contracts/src/archive.ts`).
The job id is an unguessable capability, but every read re-checks the gallery like the other public
endpoints:

| Case                                                             | Result                                   |
| ---------------------------------------------------------------- | ---------------------------------------- |
| malformed/unknown id, gallery draft/deleted, job `deleted`       | 404 `not_found` (concealed)              |
| gallery `access_version` changed since the request (password)    | 404 `not_found` (links die for everyone) |
| gallery expired                                                  | 410 `gallery_expired`                    |
| passworded gallery without a live session at the current version | 401 `password_required`                  |
| too many polls (`publicArchiveRead`, 120/min per IP)             | 429 `rate_limited`                       |

- Public statuses: `preparing` (requested/queued), `processing` (running, `progressPct`), `ready`,
  `failed` (`failureCode`), `expired` (TTL passed, or the gallery's `content_version` moved on — an
  archive of stale content is never offered, PRD §11).
- Download URLs: one per completed part, minted only while `ready`, gateway `action: 'archive'`
  tokens (≤ 5 min, `urlsExpireAt`); the page re-polls before they lapse. URLs are never logged
  (the route is `quiet`, tokens are not in log fields).
- The password session cookie is copied onto `/archive/{jobId}` and this API path when the archive
  is requested, so a passworded gallery's progress page works without widening the gallery cookie.

`/archive/[jobId]` renders the same service server-side, then polls every 2 s (paused in hidden
tabs). States: preparing/processing with a progress bar (no animation under
`prefers-reduced-motion`), ready with one link per part and the 24 h expiry, failed with "Try again"
and expired with "Prepare a new download" (both re-POST the create endpoint, which reuses a live job
for the same content), plus notices for 404/410/401/429. Built from the Lumra design system
(`packages/ui` tokens, `lm-` classes, `apps/web/src/components/ui`). Dev fixture:
`/dev/archive?state=preparing|processing|ready|failed|expired&parts=N` (404 in production).

"Download all" on `/g/[slug]` (`DownloadAllButton`) is hidden when the gallery has no ready photos.

**TTL sweep** (worker, the shared `*/15` reconcile tick with the T13 deletion sweep; a failure in
one never skips the other): `ready` jobs past `expires_at` → `expired` (≤ 200 per run, `skip
locked`) and their part objects deleted from temp-archives; queued/running jobs untouched for 1 h
with no live lease → `failed` (`stalled`), so the page offers a retry. The status API reports a
ready job past its TTL as `expired` immediately but leaves the row for the sweep, which owns the
transition together with the object deletion (storage accrual counts `ready` parts until then).

## Metering (FR-D04)

- Delivery: archive downloads are not metered or billed (ADR-008); the gateway emits no usage events.
- Storage: completed parts of `running`/`ready` jobs count toward the owner's stored bytes in the
  hourly storage accrual until they expire (see BILLING.md).
- Admission: archives reserve no cost; a new request is admitted with `checkAdmission`
  (`kind: 'archive'`), which only checks the owner's billing status (past due / canceled).

## Deletion

A photo deletion or reorder bumps `content_version`, so an in-flight build fails with
`content_changed`; ready archives of an older version are not offered again (T25 status check).
Physical removal of archive objects is by TTL (T25 sweep) and the bucket's 1-day lifecycle rule.
Deleting a gallery (T13 `gallery.delete` purge) removes everything under `archives/{galleryId}/`
(`archiveGalleryPrefix`) and marks all of the gallery's jobs `deleted`, from any state; a build
still running stops at its next conditional update (`status = 'running'` no longer matches) and
never turns `ready`. A part it finishes uploading after the purge's listing is an orphan that the
1-day lifecycle rule removes.
