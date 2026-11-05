import type { QueueMessage } from '@lumra/contracts';

/** Bindings and vars of the `lumra-worker` script (see wrangler.jsonc). */
export interface Env {
  /** Local dev / tests only; deployed environments use HYPERDRIVE. */
  DATABASE_URL?: string;
  /** Local dev only: plain-HTTP processor (`pnpm --filter @lumra/image-processor start`). */
  PROCESSOR_URL?: string;
  SENTRY_DSN?: string;
  HYPERDRIVE?: Hyperdrive;
  /** Cloudflare Containers Durable Object namespace for the image processor (ADR-002). */
  IMAGE_PROCESSOR?: DurableObjectNamespace;
  JOBS: Queue<QueueMessage>;
  ORIGINALS: R2Bucket;
  DERIVATIVES: R2Bucket;
  ARCHIVES: R2Bucket;
}
