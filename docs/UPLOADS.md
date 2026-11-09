# Uploads (T06, T10)

How photos get from the browser into the private R2 originals bucket, how quota is reserved, and
how an upload is checked before it is accepted. The spec is PRD §5.1 (FR-A01–A03, FR-A05), §5.3
(FR-M01–M04), §6.2, §7 and §10.

**Original file bytes never pass through Vercel.** The browser `PUT`s straight to R2 with
presigned URLs. Route handlers only handle JSON metadata.

## Guest drafts

| Endpoint                           | Behaviour                                                                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/guest/drafts`        | Creates `guest_sessions` and its draft `galleries` row in one transaction, then sets the `lumra_guest` cookie. Returns 201 `{galleryId, draftExpiresAt}`. If a live draft already exists, returns it with 200. |
| `GET /api/v1/guest/drafts/current` | Returns the draft, quota usage and each item's media and upload status. Returns 404 if the cookie is missing, malformed, expired or claimed.                                                                   |

- The capability is 256 random bits, base64url-encoded. It is sent only in an `HttpOnly; SameSite=Lax`
  cookie, with `Secure` added in production. The cookie expires when the draft does.
- Only `HMAC-SHA256(GUEST_CAPABILITY_PEPPER, capability)` is stored, in `guest_sessions.capability_hash`.
- `expires_at` is set once, at creation, to DB `now() + 24 h`. Nothing ever extends it.
- The browser uses `apps/web/src/lib/draft-store.ts` (IndexedDB) to keep the draft id and
  non-sensitive progress data for resume. That data is the file's name, size, type and
  `lastModified` (enough to match a reselected `File`), the intent and media ids, and the part
  ETags. Each record is rebuilt field by field before it is written, so file bytes, presigned URLs
  and the capability are never persisted.

## Upload endpoints

All of these return `{data, error, requestId}` with `Cache-Control: no-store`.

| Endpoint                                     | Result                                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/galleries/{id}/upload-intents` | `{filename,mime,size,clientId}` → 201 `{intentId, mediaId, multipart, partSize, partCount, expiresAt, status, mediaStatus}`. A replay with the same `clientId` returns 200. |
| `POST /api/v1/uploads/{id}/parts/sign`       | `{partNumbers}` → presigned `PUT` URLs. The first signature moves the media from `reserved` to `uploading`.                                                                 |
| `GET /api/v1/uploads/{id}`                   | Upload state plus the parts R2 already holds (from server-side `ListParts`), used for resume. Contains no credentials.                                                      |
| `POST /api/v1/uploads/{id}/complete`         | `{parts:[{number,etag}], checksum?}` → `uploaded`. Idempotent.                                                                                                              |
| `POST /api/v1/uploads/{id}/abort`            | Idempotent cancel. Releases the reservation.                                                                                                                                |

### Flow

1. **Intent.** The handler locks the gallery row (`FOR UPDATE`), then, in one transaction:
   - authorizes the caller;
   - checks idempotency (`upload_sessions.idempotency_key = intent:{galleryId}:{clientId}`);
   - checks the item count (at most 2,000 non-deleted items);
   - reserves quota;
   - inserts `media` (`reserved`, `sort_key` after the current last key) and its `upload_sessions` row.

   The object key is `originals/{ownerUserId | guestSessionId}/{galleryId}/{mediaId}/source`. The
   user's filename is never part of the key. It is stored sanitized in `media.filename`, and files
   with unsupported extensions are rejected with a 422.

   If the file is larger than 8 MiB (`planUpload`), the R2 multipart upload is created after the
   transaction commits, so no DB lock is held during a network call. It is recorded once with a
   conditional update; if two requests race, the loser aborts its own multipart upload.

2. **Sign.** URLs live at most 15 minutes (`clampPresignTtl`). Each URL signs `content-length`
   (the part's exact planned length). A single `PUT` URL also signs `content-type`. A part URL is
   bound to its `uploadId` and `partNumber`. Part numbers outside the plan are rejected with a 422.
3. **Upload.** The browser `PUT`s each part and reads the `ETag` response header, which CORS
   exposes. It persists the ETags in IndexedDB.
4. **Resume.** `GET /api/v1/uploads/{id}` returns the parts R2 holds. The client re-signs and
   re-uploads only the missing parts. If the client can no longer reselect the `File`, the UI shows
   the resume prompt (T14).
5. **Complete.** See _Verification strategy_ below. In the same transaction, the media moves
   `reserved/uploading → uploaded` (checked against `MEDIA_TRANSITIONS`), the session moves to
   `completed`, and a `job_outbox` row is written: `media.uploaded`, with payload
   `{type, mediaId, traceId, dedupeKey}` and `dedupe_key = media.uploaded:{mediaId}`. The
   insert uses `ON CONFLICT DO NOTHING`. A replay returns the stored result and never writes a
   second outbox row. After the commit, the route schedules (Next `after()`, so the response is
   not delayed) a best-effort `POST {WORKER_URL}/internal/relay` with
   `Authorization: Bearer {WORKER_KICK_SECRET}` (3 s timeout, failures logged at warn and
   swallowed). The worker runs one bounded outbox relay pass, so processing starts within seconds;
   without the two env vars, or if the kick fails, the once-a-minute cron relay picks the row up.
6. **Abort.** The session moves to `aborted`. The media moves to `deleting` (with `deleted_at` and
   `failure_code = upload_aborted`); PRD §7 allows any non-deleted state to move there. The guest
   reservation is released with `release_guest_upload`, and a `media.delete` outbox row (deduped)
   is written so the cleanup worker removes any partial object. After that, the R2 multipart upload
   is aborted on a best-effort basis; the bucket lifecycle rule aborts any left over after 2 days.
   Aborting a completed upload returns 409; use `DELETE /media/{id}` instead.

### Authorization

- The rules follow the PRD §6.2 access matrix.
- **Account galleries.** Only the owner, verified with Supabase `getUser()` on the server.
- **Guest drafts (no owner yet).** Only the guest session proven by the cookie.
  - A guest cookie never grants access to an account gallery.
  - A signed-in user who still holds the guest cookie can keep uploading to the draft (J1, before
    the claim).
- **Status codes.**
  - No credential at all: 401 (this includes an expired or claimed draft cookie).
  - Not authorized: 404, so the resource's existence is not revealed. This covers another user's
    or guest's gallery or upload, deleted galleries and malformed ids.
- **Origin check.** Mutations reject a cross-origin `Origin` header with 403, on top of the
  SameSite cookies.

### Quota and admission

- **Guest.** `reserve_guest_upload()` runs one conditional `UPDATE`: at most 20 files and at most
  250,000,000 bytes, on an unexpired, unclaimed session. Concurrent calls serialize on the row
  lock, so 21 parallel intents produce exactly 20 successes (tested).
  - A refusal returns 403 `quota_exceeded` with `details.reason` set to `guest_file_limit` or
    `guest_byte_limit`, plus `requiresAuth: true`. The UI uses this to prompt sign-in (§14.2 #2).
  - `upload_sessions.guest_session_id` records which guest quota holds the reservation. Abort
    releases exactly that reservation, even after a claim.
  - A guest reservation expires with its draft.
- **Account.** `checkAdmission` from `@lumra/billing` runs inside the intent transaction with the
  `billing_accounts` row locked, so one account's intents are admitted one at a time. Account
  reservations expire after 48 h.
  - _Committed_ bytes are media that are `uploaded`, `processing` or `ready`, plus `failed` or
    `deleting` media whose upload completed.
  - _Pending_ bytes are live intents: media that are `reserved` or `uploading` and still have an
    unexpired pending session.
  - Both are converted with `estimateStoredFootprintBytes`.
  - Free accounts are refused once the projected total exceeds 1 GB. That returns 403
    `quota_exceeded` with reason `free_storage_cap`.
  - A Pro account over its spending cap gets 402 `spend_cap_reached`. An account that is
    `past_due` or canceled gets 403 `forbidden`.
- **Derivative estimate.** Derivatives do not exist until processing, so each upload reserves
  `original + ceil(original × 25 %) + 100 kB`. The constants are in `STORAGE_ESTIMATE` in
  `packages/config/src/limits.ts`.
  - The four WebP widths (320/640/1280/2048, never upscaled) typically add 3–10 % to a camera
    JPEG.
  - The 25 % + 100 kB margin also covers small, already-compressed sources.
  - Example: 79 × 10 MB photos fit under the Free 1 GB cap.
  - Tune the constants once T12 reports real derivative sizes.

## Verification strategy (FR-M04)

A multipart upload's ETag is an MD5 of the part MD5s. It is **not** a checksum of the whole file,
and single-PUT ETags are not guaranteed to be MD5s either. Completion therefore checks the following.

1. **Every planned part is present.** The client's list must be exactly `1..partCount`, with no
   duplicates.
2. **Each part matches what R2 actually holds.** For every part, server-side `ListParts` must
   report the same ETag and **exactly the planned length**. The planned length is also signed into
   that part's URL, so a client cannot upload a different length. Mismatches return 409
   `part_mismatch` (retryable) before anything is assembled.
3. **R2 assembles the parts.** `CompleteMultipartUpload` is sent with the client's ETags; R2
   rejects ETags that don't match. If the upload is already gone (`NoSuchUpload`), a concurrent
   completion is assumed and step 4 decides.
4. **The object exists and its size is exact.** `HEAD` must find the object, and its size must
   equal `upload_sessions.reserved_bytes` byte for byte.
   - A missing object returns 409 `object_missing` (retryable).
   - A wrong size returns 409 `size_mismatch` and the upload stays pending, so the client can
     re-upload. After a multipart upload the bad provider upload id is cleared, and the next sign
     starts a fresh multipart upload over the object.
5. **Content integrity (SHA-256).** If the client sends `checksum`, the hex SHA-256 of the whole
   file computed in the browser, it is stored in `media.checksum_sha256`.
   - The image worker (T11/T12) must stream the original anyway to sniff and decode it. It hashes
     the bytes while doing so and fails the media with `checksum_mismatch` if they differ.
   - Doing this in the worker avoids re-reading 50 MB objects inside a Vercel function. It also
     avoids relying on R2 checksum headers that would have to be known before the upload starts.
   - Without a client checksum, integrity rests on steps 1–4 plus the worker's decode/sniff
     (`sniffImage`), which rejects truncated or malformed files.

## Rate limits and bot challenge (FR-A05)

- **Storage.** `apps/web/src/lib/rate-limit.ts` keeps counters in Postgres
  (`rate_limit_buckets`, service-only, RLS on).
- **Algorithm.** A sliding-window counter: the current fixed window plus the previous one,
  weighted by how much of it still overlaps. Each hit is one atomic upsert in
  `rate_limit_hit()` using the DB clock. Expired buckets are pruned opportunistically.
- **Keys.** Keys look like `{rule}:{hmac}`, where the HMAC is over the truncated client IP (IPv6
  to /64), the user id or the guest session id, keyed with `RATE_LIMIT_PEPPER` (falling back to
  `GUEST_CAPABILITY_PEPPER`, domain-separated) and truncated to 128 bits. Raw IPs are never
  stored or logged.
- **Thresholds.** Defined in `RATE_LIMITS` (`packages/config/src/limits.ts`):

  | Rule               | Subject   | Limit                                       |
  | ------------------ | --------- | ------------------------------------------- |
  | `guestDraftCreate` | per IP    | 20 per hour; challenge above 5              |
  | `uploadIntent`     | principal | 300 per minute                              |
  | `uploadSign`       | principal | 600 per minute                              |
  | `uploadMutate`     | principal | 600 per minute (status, complete and abort) |

- **Over the limit.** The response is 429 `rate_limited` with `Retry-After`.
- **Turnstile.** The bot challenge is active only when `TURNSTILE_SECRET_KEY` is set. Above
  `challengeAt`, a request without a valid `x-turnstile-token` header gets 429 with
  `details.challenge = "turnstile"`. Tokens are verified server-side with Cloudflare `siteverify`.

## Configuration

These variables are required **at use**. If one is missing, the request fails with the generic
500 and the server logs the variable's name. Builds, CI and pages that don't need a variable
still work without it.

| Variable                                                    | Needed by                                             |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `DATABASE_URL`                                              | All DB-backed routes                                  |
| `GUEST_CAPABILITY_PEPPER`                                   | Guest drafts and the rate-limit fallback pepper       |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Multipart creation, signing, complete and abort       |
| `R2_BUCKET_ORIGINALS`                                       | Originals bucket name (defaults to `lumra-originals`) |
| `R2_ENDPOINT`                                               | Optional: local fake or jurisdiction endpoint         |
| `RATE_LIMIT_PEPPER`                                         | Optional: dedicated pepper for rate-limit keys        |
| `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`    | Optional: turns on bot challenges                     |

## Browser upload client (T14)

The client lives in `apps/web/src/lib/upload/` (framework-agnostic TypeScript) and
`apps/web/src/components/upload/` (React). `/new` mounts `GalleryUploader`; the gallery editor
mounts the same component with `mode="owner"`.

### Engine (`UploadEngine`)

- **States.** `queued → uploading → uploaded → processing → ready`, plus recoverable `failed`,
  `cancelled` and `removed` (PRD §4). `awaiting_file` is the resume state after a reload: the
  engine knows the intent and completed parts but needs the user to reselect the `File`.
- **Pre-check (FR-M08).** `precheckFile` (extension, ≤ 50 MB, magic bytes of the first 256 KiB)
  runs before any request. Rejections come back from `addFiles` with user-facing text
  (`messages.ts`). Duplicate picks (same name, size and `lastModified`) are skipped.
- **Intent.** One `clientId` (UUID) per file, kept across retries, so a retried intent replays
  (200) instead of reserving twice.
- **Parts.** Single PUT or multipart per the intent's `partSize`/`partCount`. Parts are signed in
  batches of 10 and uploaded with `XMLHttpRequest` (fetch has no upload progress). A failed part
  is re-signed and retried with capped exponential backoff and equal jitter (`backoff.ts`:
  500 ms base, 30 s cap, delay in `[cap/2, cap]`), 6 attempts, then the file is `failed` and
  `Retry` resumes it. `Retry-After` on 429 (API or part PUT) is honoured, capped at 120 s. API
  calls retry only on network errors, 5xx and 429.
- **Concurrency.** 3 files on desktop, 2 on touch devices (`UPLOAD_LIMITS`), 1–2 when
  `navigator.connection` reports `saveData`, `2g` or `3g`. Every error or slow part
  (< 32 KiB/s) lowers the limit by one; four successes earn a slot back.
- **Checksum.** `crypto.subtle.digest` is one-shot, so SHA-256 is computed incrementally with
  hash-wasm in 4 MiB slices on the main thread (yielding between slices), in parallel with the
  part uploads. It is sent with `complete` when available; if hashing fails it is skipped.
- **Complete.** Sends the ordered part ETags. On a retryable 409 (`part_mismatch`,
  `object_missing`, `no_parts`, `size_mismatch`) the engine reconciles with
  `GET /uploads/{id}`, re-uploads what R2 lacks and completes again (up to twice).
- **Resume.** Progress refs go to `draft-store` (IndexedDB): name, size, type, `lastModified`,
  intent/media ids and part ETags. File bytes and URLs are never stored. On reload the
  uploader shows "N uploads were interrupted" and asks for the same files. Matched files
  resume after `GET /uploads/{id}`: only parts R2 does not list (or that have the wrong length)
  are sent. An aborted or expired intent restarts with a new `clientId`.
- **Errors.** Guest `quota_exceeded` (`requiresAuth`) and 401 set `authPrompt`. The UI then
  links to `/auth?intent=publish&galleryId=…&returnTo=/new?gallery=…`, which claims the draft
  and returns to the same gallery in owner mode. Uploaded photos stay in the draft, and the
  refused files come back as "choose again" items. The guest limits (20 files / 250 MB) are
  also checked locally, so the 21st file prompts sign-in without a reservation request.
  A 404 is a non-retryable "gallery no longer available".
- **Processing status.** After `complete` the engine polls: guests poll
  `GET /guest/drafts/current` (one request for the whole draft, which also refreshes the quota),
  owners poll `GET /uploads/{id}` for at most 5 items per tick. TODO(T15): use the gallery
  detail endpoint. The interval is 3 s, growing ×1.5 up to 15 s while nothing changes.
- **Cancel / remove.** Cancel aborts the in-flight PUT and calls `POST /uploads/{id}/abort`.
  Remove only applies to unfinished items; deleting a finished photo is `DELETE /media/{id}`
  (T15).

### UI

- `UploadZone`: drag-and-drop plus a real "Choose photos" button that opens the hidden
  `<input type=file multiple accept=…jpeg,png,webp,heic>`. The button works with Enter or Space,
  and the drag hint is hidden on coarse pointers.
- `UploadList`: one tile per file (preview, status text, per-file progress bar) with
  Retry/Cancel/Remove (≥ 44 px), a total progress bar, and a polite `aria-live` summary throttled
  to one update every 3 s.
- `GalleryUploader`: composes the zone and the list with the resume and sign-in prompts, and
  warns on `beforeunload` while uploads run.
- The title field on `/new` is client-side only. TODO(T15): persist it with
  `PATCH /galleries/{id}`.

## Tests

- **Unit** (`pnpm test`): `apps/web/src/lib/rate-limit-key.test.ts` (IP truncation, peppered
  hashing, sliding window) and `draft-store.test.ts` (IndexedDB via `fake-indexeddb`). Pure plan
  helpers are covered in `packages/media/src/upload-plan.test.ts`, and the footprint estimate in
  `packages/billing/src/footprint.test.ts`.
- **Integration** (`pnpm test:db`): `apps/web/test-db/*.test.ts` runs the real route handlers
  against local Supabase. `next/headers` cookies, Supabase `getUser` and R2 are faked; R2 is
  faked at the `fetch` level (`test-db/fake-r2.ts`). The fake checks presigned `PUT`s with an
  independent SigV4 implementation, plus expiry, signed length and signed content type.
- **Client** (`pnpm test`): `apps/web/src/lib/upload/engine.test.ts` runs the engine against a fake
  API and fake R2 (`test-fakes.ts`) with fake timers. It covers state transitions, jittered part
  retries, `Retry-After`, concurrency limits, cancel, the guest quota sign-in prompt, 401/404,
  and resume skipping parts R2 has. `components/upload/upload.test.tsx` covers keyboard
  activation, unsupported-file rejection, actions and throttled `aria-live` text.
- **E2E.** `tests/e2e/specs/new.spec.ts` runs without a stack: the zone is visible, it works from
  the keyboard only, and unsupported files are rejected client-side.
  `specs/supabase/upload.spec.ts` (`E2E_SUPABASE=1`) uses the real routes and Postgres, with R2
  replaced by a fake S3 server (`specs/supabase/fake-s3.ts` on port 54399 via `R2_ENDPOINT`). It
  checks that a CDP-throttled 20 MiB multipart upload recovers from a forced part-2 failure, and
  that after a reload, reselecting the file resumes without re-sending part 1.

## Manual QA (needs real R2 credentials)

1. Set the R2 variables for the dev bucket and start `pnpm --filter @lumra/web dev`.
2. Create a draft: `curl -i -X POST localhost:3000/api/v1/guest/drafts`. Check that the response
   sets `Set-Cookie: lumra_guest=…; HttpOnly; SameSite=lax`.
3. Create an intent for a 20 MB JPEG, sign parts 1–3, then `PUT` each slice with
   `curl --upload-file` using the returned headers. Record the ETags and call complete.
4. Upload only part 1, call `GET /api/v1/uploads/{id}` and check that it lists part 1. Then
   finish the upload.
5. Run `wrangler r2 object get` on the key and compare its `sha256sum` with the local file.
6. Abort a fresh multipart intent and check that `ListMultipartUploads` no longer shows it.
