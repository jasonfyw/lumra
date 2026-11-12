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

| Caller / state                                      | Result                                                   |
| --------------------------------------------------- | -------------------------------------------------------- |
| unknown slug, draft, deleted gallery                | 404 `not_found` (indistinguishable)                      |
| expired gallery                                     | 410 `gallery_expired`                                    |
| passworded gallery without a live session at the    | 401 `password_required` (wrong password, other gallery's |
| current `access_version`                            | session, or a password change since unlocking)           |
| foreign `Origin`                                    | 403; malformed body 422                                  |
| no ready photos (or none of `mediaIds` ready)       | 409 `conflict` (`no_ready_items`, retryable)             |
| 5 jobs already building for the gallery             | 429 `rate_limited`, `Retry-After: 60`                    |
| more than 20 requests / hour from one IP            | 429 (`publicArchiveCreate`)                              |
| owner past due / canceled / Free delivery cap / cap | 403 `quota_exceeded` (`archive_unavailable`; no billing  |
| reached (PRD §9.4)                                  | detail is shown to recipients, the reason is logged)     |

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

## Metering (FR-D04)

- Delivery: the gateway emits `delivery.served` (`action: 'archive'`, `archivePartId`) per
  byte-bearing response; the usage consumer meters it into `usage_ledger` like any download.
- Storage: completed parts of `running`/`ready` jobs count toward the owner's stored bytes in the
  hourly storage accrual until they expire (see BILLING.md).
- Admission: archives being built are reservations (fully delivered estimate), and a new request is
  admitted with `checkAdmission` (`kind: 'archive'`).

## Deletion

A photo deletion or reorder bumps `content_version`, so an in-flight build fails with
`content_changed`; ready archives of an older version are not offered again (T25 status check).
Physical removal of archive objects is by TTL (T25 sweep) and the bucket's 1-day lifecycle rule.
Deleting a gallery (T13 `gallery.delete` purge) removes everything under `archives/{galleryId}/`
(`archiveGalleryPrefix`) and marks all of the gallery's jobs `deleted`, from any state; a build
still running stops at its next conditional update (`status = 'running'` no longer matches) and
never turns `ready`. A part it finishes uploading after the purge's listing is an orphan that the
1-day lifecycle rule removes.
