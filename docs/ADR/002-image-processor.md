# 002. Image processor runtime

Status: Accepted · Date: 2026-11-05 · Task: T12

## Context

Derivatives need HEIC decoding, EXIF orientation and ICC → sRGB conversion (FR-M05/M06). That requires native
libvips + libheif, which can't run in Vercel functions or plain Workers (PRD §6.1, §17).

## Decision

Run the processor as a **Cloudflare Containers** image (Node + sharp built with libheif), invoked from the
`apps/worker` queue consumer for `media.uploaded` messages. The archive builder (T24) reuses the same container
image with a separate entry point. Containers scale to zero when idle.

## Consequences

- Everything media-related stays on Cloudflare: R2 reads/writes go through bindings with no egress, and one
  account holds the queues, DLQ and observability.
- The container image is built and pushed by `wrangler deploy`; CI needs Docker for that job.
- Processing is sandboxed per container instance. Decompression-bomb limits (pixel cap) are enforced in sharp
  before decode, so a hostile file can't take down the queue consumer.

## Alternatives considered

- Fly Machines / Render: mature, but adds a second cloud, R2 egress over the public internet, and separate
  credentials to manage.
