import type { QueueMessage } from '@lumra/contracts';

/** Bindings and vars of the `lumra-worker` script (see wrangler.jsonc). */
export interface Env {
  /** Local dev / tests only; deployed environments use HYPERDRIVE. */
  DATABASE_URL?: string;
  /** Local dev only: plain-HTTP processor (`pnpm --filter @lumra/image-processor start`). */
  PROCESSOR_URL?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  LOG_LEVEL?: string;
  /** Deployed git SHA, e.g. `wrangler deploy --var COMMIT_SHA:$GITHUB_SHA`. */
  COMMIT_SHA?: string;
  /**
   * Bearer secret for `POST /internal/relay` (the web app's post-finalize kick). Unset ⇒ the
   * endpoint answers 503 and processing relies on the once-a-minute cron relay alone.
   */
  WORKER_KICK_SECRET?: string;
  HYPERDRIVE?: Hyperdrive;
  /** Cloudflare Containers Durable Object namespace for the image processor (ADR-002). */
  IMAGE_PROCESSOR?: DurableObjectNamespace;
  /** Gallery access state mirrored for the media gateway (ADR-001); written by T20 handlers. */
  ACCESS_STATE: KVNamespace;
  JOBS: Queue<QueueMessage>;
  ORIGINALS: R2Bucket;
  DERIVATIVES: R2Bucket;
  ARCHIVES: R2Bucket;
}
