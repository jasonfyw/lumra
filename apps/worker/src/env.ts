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
  /**
   * Stripe secret key for the Billing Meter export (T31; secret). Unset ⇒ the export is skipped
   * and nothing is built, so cursors never advance without a way to send.
   */
  STRIPE_SECRET_KEY?: string;
  /**
   * Resend API key for application email (`email.send`; secret). Unset => messages are logged
   * and acked without sending (no crash).
   */
  RESEND_API_KEY?: string;
  /** Sender, default `Lumra <hello@lumra.photos>` (verified Resend domain lumra.photos). */
  EMAIL_FROM?: string;
  /** Optional Reply-To address. */
  EMAIL_REPLY_TO?: string;
  /** Public app origin for links in emails, default `https://www.lumra.photos`. */
  APP_URL?: string;
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
