# 002. Image processor runtime

Status: Accepted · Date: 2026-11-05 · Task: T12

## Context

Derivatives need HEIC decoding, EXIF orientation and ICC → sRGB conversion (FR-M05/M06). That requires native
libvips + libheif, which can't run in Vercel functions or plain Workers (PRD §6.1, §17).

## Decision

Run the processor as a **Cloudflare Containers** image (Node + sharp built with libheif), invoked from the
`apps/worker` queue consumer for `media.uploaded` messages. The archive builder (T24) reuses the same container
image with a separate entry point. Containers scale to zero when idle.

### Implementation (T12)

- **Image** (`apps/image-processor/Dockerfile`): Node 22 on Debian trixie; libde265 1.0.16 → libheif 1.22.0
  (HEVC decode only, every other codec off) → libvips 8.18.7 built with only JPEG, PNG, WebP, HEIF, libexif and
  LCMS; sharp 0.35.5 compiled from source against it. sharp's prebuilt binaries are not used in the image
  because their libheif has no HEVC decoder (they decode AVIF only). Tarballs are pinned by SHA-256 and the
  runtime stage is `node:22-trixie-slim` plus the exact shared objects sharp links (≈435 MB, runs as `node`).
  CI builds the image and runs `scripts/smoke.mjs`, which decodes a committed HEIC fixture end to end.
- **Pipeline** (`src/process.ts`): magic-byte gate (`sniffImage`) before libvips sees the bytes, so loaders for
  other formats are unreachable; pixel cap checked from headers and again via `limitInputPixels`; one decode per
  variant with `autoOrient`, `toColourspace('srgb')` (embedded ICC profile applied, none written), resize without
  enlargement, WebP q80 effort 4, all metadata stripped. Widths 320/640/1280/2048 that fit the oriented source,
  with a native-width `w320` for sources narrower than 320 px. `taken_at` comes from EXIF `DateTimeOriginal`
  (+ `OffsetTimeOriginal`). One job per instance, 60 s budget, libvips cache off, 2 libvips threads.
- **Errors**: permanent rejections reuse `MEDIA_REJECTION_CODES` (+ new `processing_timeout`) as HTTP 422/413;
  environment problems (`processor_busy`, `processor_unavailable` — e.g. a missing HEVC decoder —,
  `internal_error`) are 5xx and retried, so a bad deploy never marks user photos `failed`.
- **Integrity**: the manifest carries the SHA-256 of the received bytes; the Worker compares it with the
  client checksum recorded at finalize (`media.checksum_sha256`, T10) and fails the media with
  `checksum_mismatch` before writing any derivative (FR-M04).
- **Transport**: the Worker reads the original from the `ORIGINALS` binding and streams it as the request
  body (never buffered in the Worker). Workers reach the container through the Durable Object namespace
  `IMAGE_PROCESSOR` (pool of 4 named instances, `enableInternet = false`, no credentials in the container);
  local dev uses plain HTTP via `PROCESSOR_URL`. Both sit behind the `ProcessorClient` interface.
- **Throughput and deadlines** (processing-stall fix): the consumer takes batches of ≤ 4 messages
  (`max_batch_timeout: 1`) and runs them concurrently, each on its own pool slot (`image-processor-N`), so jobs
  of one batch never collide with `processor_busy`. Instances sleep after 15 idle minutes. Every DB / R2 /
  processor call has a deadline and each job is cut off at 120 s (`apps/worker/src/deadline.ts`); a timeout
  retries after 5 s, 15 s, 60 s … instead of hanging the invocation until the 900 s wall-time kill. Finalize
  kicks `POST /internal/relay` on the worker so the outbox is relayed within seconds; the per-minute cron relay
  remains the fallback and the only other publish path.

### Response format: manifest-first `multipart/form-data`

`POST /process` answers with a multipart body whose first field is a JSON manifest (`processManifestSchema`)
followed by one `image/webp` part per variant. Rationale:

- Both runtimes parse it natively (`Response.formData()` in workerd and Node), so there is no hand-rolled
  multipart parser on either side, and Node serialises it as a stream (`new Response(formData).body`).
- Manifest first lets the consumer validate media id, pipeline version and part sizes before touching parts.
- The payload is bounded: ≤ 4 parts, each capped by the 2048 px width, typically well under 2 MB in total.
  The Worker buffers only this derivative set, never the original. A JSON manifest + separate fetches would
  need the container to keep results between requests (state on a scale-to-zero instance) and an extra round
  trip per variant; the multipart body can later be parsed incrementally without a contract change.

## Consequences

- Everything media-related stays on Cloudflare: R2 reads/writes go through bindings with no egress, and one
  account holds the queues, DLQ and observability.
- The container image is built and pushed by `wrangler deploy` (run `pnpm --filter @lumra/image-processor build`
  first, since the Dockerfile copies `dist/`); CI needs Docker for that job. A from-source libvips build takes a
  few minutes; layer caching keeps rebuilds fast.
- Processing is sandboxed per container instance. Decompression-bomb limits (pixel cap) are enforced before
  decode, so a hostile file can't take down the queue consumer.
- `pnpm test` stays hermetic: it uses sharp's prebuilt binaries (HEIC decode is asserted to fail as retryable
  there); HEIC decoding is verified only by the Docker smoke test.
- Encoder changes must bump `DERIVATIVE_ENCODING.pipelineVersion`; it is part of the derivative variant hash, so
  new objects get new keys and stale ones are deleted after the row switches over.

## Alternatives considered

- Fly Machines / Render: mature, but adds a second cloud, R2 egress over the public internet, and separate
  credentials to manage.
- libheif compiled to WASM (`libheif-js`) inside a Worker: avoids containers but has no ICC handling, is slow
  for 48 MP iPhone images and runs into Worker memory limits.
- sharp's prebuilt binaries: no HEVC decoder (patent-encumbered codecs are excluded upstream).
