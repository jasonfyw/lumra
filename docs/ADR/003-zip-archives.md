# 003. ZIP implementation, partition sizes and where archives are built

Status: Accepted · Date: 2026-11-11 · Task: T24 (T25 for progress/TTL)

## Context

"Download all" must hand recipients the exact originals of up to 2,000 photos (50 MB each at most)
without routing bytes through Vercel (FR-D02–D05, PRD §6.1). Archives are built in the background,
must be resumable/idempotent, must never serve stale or deleted media (PRD §11: the job binds
`content_version`), and are kept for 24 h in the private `temp-archives` bucket, delivered through
the media gateway (ADR-001). PLAN §2 proposed "streamed STORE-mode ZIP built in the worker
container". ADR-002 said the archive builder would reuse the image-processor container image.

## Decision

### Format: streamed STORE ZIP (`@lumra/media` `ZipStreamWriter`)

- Method 0 (stored) for every entry: JPEG/HEIC/WebP/PNG are already compressed; deflate would cost
  CPU for ~0 % gain. Entry bytes are the originals, byte for byte.
- Streaming: local headers set general-purpose bit 3; the CRC-32 (computed incrementally while the
  bytes pass through) and sizes follow each entry in a data descriptor. Memory is O(entries).
- UTF-8 names (bit 11). Names come from `@lumra/domain` `sanitizeArchiveFilename` +
  `dedupeFilenames`, computed once over the **whole** archive in display order (so extracting all
  parts into one folder never overwrites a file); the writer additionally refuses separators/`..`.
- ZIP64 per entry and for the end records whenever a size/offset/count needs it. With the bounds
  below a part never needs it, but the writer handles it and tests force it.
- Validated in tests with Info-ZIP `unzip -t`/`unzip -p` and Python `zipfile.testzip()`
  (STORE, ZIP64, empty archive, unicode names, extraction stays inside the target directory).

### Partitions: ≤ 500 items and ≤ 2 GB (decimal) of originals per part

Kept from the PRD (`ARCHIVE_LIMITS`). `planArchive` splits greedily in display order; a 2,000-item
gallery yields ≥ 4 parts. Each part is one object `archives/{gallery}/{job}/{part}.zip`. Parts are
independent ZIPs (not a split/spanned archive), so each opens on its own on any OS and mobile
browsers get one link per part (FR-D05).

### Where: a plain Worker queue consumer, not the container

`archive.build` runs in `apps/worker` (the `JOBS` queue consumer), streaming R2 → ZIP writer →
R2 multipart upload through bindings. Evaluation for a 2 GB part:

| Constraint                     | Worker queue consumer                                                                                                                                       | Image-processor container (`ImageProcessorContainer`)                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wall time                      | 15 min per invocation; the job deadline is 14 min (`DEADLINES.archiveJobMs`). The work is I/O-bound R2→R2 over bindings (no egress).                        | Unbounded, but the Worker that calls it is still bound by its own invocation limit.                                                                                          |
| CPU                            | Only CRC-32 + memcpy. CRC uses `node:zlib` `crc32` (native in workerd under `nodejs_compat`; pure-JS slice-by-8 fallback). `limits.cpu_ms` raised to 5 min. | Native Node, but the CPU saved is small.                                                                                                                                     |
| Memory                         | One 8 MiB multipart buffer per build (`ARCHIVE_LIMITS.uploadPartBytes`), plus stream chunks: ≪ 128 MB even with a full batch of 4 builds.                   | 4 GiB instance, not needed.                                                                                                                                                  |
| Access to R2                   | Direct bindings (`ORIGINALS`, `ARCHIVES`).                                                                                                                  | `enableInternet = false` and no credentials (ADR-002): every byte would have to be streamed Worker → container → Worker, so the Worker would still move all 2 GB, twice.     |
| Concurrency / capacity         | Scales with queue consumers; no shared pool.                                                                                                                | A pool of 4 single-job instances shared with photo processing: a gallery's "Download all" would block uploads' derivative generation (or need a second pool/image to build). |
| Moving parts / deploy coupling | None new.                                                                                                                                                   | New container endpoint, image rebuilds, and the Docker CI job for any archive change.                                                                                        |

The container brings nothing the Worker lacks for a STORE ZIP (no decoding, no compression), while
adding a double hop and competing with image processing. **The Worker is the right place**; this
supersedes PLAN §2's "worker container" wording and ADR-002's note that the archive builder would
reuse the container image. Revisit if parts ever need compression or transformation.

### Resumability, idempotency, content binding

- The web app fixes each part's ordered entries (`archive_parts.entries`), item count, source bytes
  and object key at request time, in the same transaction as the job (`queued`) and its
  `archive.build` outbox row. Rebuilding a part always produces the same bytes under the same key.
- A lease (`archive_jobs.lease_until`, 15 min) gives one delivery the build; a concurrent
  redelivery retries after the lease (`RetryLaterError`, no Sentry noise). `queued → running` on
  claim; transitions follow `ARCHIVE_TRANSITIONS`.
- Granularity is the part: completed parts are skipped on retry; an interrupted part's multipart
  upload (`archive_parts.upload_id`) is aborted and the part rebuilt. Each R2 multipart part is
  8 MiB (R2 needs equal-sized parts ≥ 5 MiB except the last; 2 GB ≈ 240 parts ≪ 10,000).
- Content binding: the gallery must stay published, undeleted and at the job's `content_version`
  — checked before each part, every 50 entries, and inside the transactions that record a part and
  mark the job `ready`. Otherwise the job fails with `content_changed` / `gallery_unavailable`
  (never silently stale). Reorders and photo deletions bump `content_version` (gallery editor, docs/GALLERIES.md).
- Permanent failures (`content_changed`, `gallery_unavailable`, `original_missing`) fail at once;
  transient ones are retried by the queue and become `build_failed` after 5 attempts.

### Reuse

`POST …/archives` returns an existing job when gallery, `content_version`, `access_version` and
`source_fingerprint` (SHA-256 over the ordered `mediaId/name` list) match and the job is building or
`ready` with ≥ 2 h retention left. The fingerprint is needed because a photo finishing processing
does not bump `content_version` but changes what "Download all" contains. At most 5 non-terminal
jobs per gallery; requests are rate limited per IP (`publicArchiveCreate`).

## Consequences

- No new infrastructure: the existing `ARCHIVES` bindings, queue and DLQ are reused. The worker
  script gets `limits.cpu_ms = 300000`.
- A part interrupted at 1.9 GB restarts from its first byte (wasted I/O, never wrong output).
- Delivery of parts is metered by the gateway's `delivery.served` (`action: 'archive'`), counted
  per response byte like any download (FR-D04). Stored archive bytes are included in storage
  accrual while the job is `running`/`ready` (BILLING.md).
- Downloads use HTTP Range through the gateway, so browsers can resume a 2 GB part.

## Alternatives considered

- **Container build** — see the table: double transfer, shared single-job pool, more moving parts.
- **Deflate** — CPU for nothing on already-compressed photos (lossless, but ~0 % smaller).
- **One ZIP64 archive for the whole gallery** — up to 100 GB in one object and one HTTP response:
  fragile on mobile, unbounded build time per queue delivery. Rejected by FR-D03.
- **Precomputed local-header CRCs (two reads per original)** — avoids data descriptors but doubles
  R2 reads; every mainstream extractor reads stored entries with descriptors via the central
  directory.
- **Client-side ZIP in the browser** — hundreds of parallel downloads on mobile (FR-D05) and no
  resumability.
