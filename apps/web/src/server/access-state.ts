import 'server-only';
import { jobOutbox } from '@lumra/db';
import type { Database } from '@lumra/db';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Call inside the same transaction as any change to a gallery's access-relevant fields
 * (publish, password, expiry, suspension, deletion). The worker re-reads the gallery and
 * rewrites its KV access state for the media gateway (ADR-001). Each change gets its own
 * outbox row; the handler is idempotent because it always writes the current DB state.
 */
export async function enqueueAccessStateSync(tx: Tx, galleryId: string, traceId: string) {
  const dedupeKey = `gallery.access_changed:${galleryId}:${crypto.randomUUID()}`;
  await tx.insert(jobOutbox).values({
    eventName: 'gallery.access_changed',
    aggregateId: galleryId,
    payload: { type: 'gallery.access_changed', galleryId, traceId, dedupeKey },
    dedupeKey,
  });
}
