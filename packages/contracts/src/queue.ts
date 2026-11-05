import { z } from 'zod';
import { MEDIA_ACTIONS, MEDIA_VARIANTS } from './media-token';

/**
 * Queue messages carry IDs only — never secrets or file bytes (PRD §6.1).
 * `traceId` propagates the originating request ID for cross-runtime tracing.
 */
const base = { traceId: z.string(), dedupeKey: z.string() };

/**
 * Emitted by the media gateway once per successful byte-bearing response (FR-D04).
 * `bytes` is the object size, or the range length for 206 responses. `dedupeKey` is
 * `{jti}:{start}-{end}` so a retried send of the same response is counted once.
 * Consumed by usage-ledger ingestion (T27) from the `lumra-usage-*` queue.
 */
export const deliveryServedMessageSchema = z.object({
  type: z.literal('delivery.served'),
  galleryId: z.uuid(),
  action: z.enum(MEDIA_ACTIONS),
  mediaId: z.uuid().nullable(),
  archivePartId: z.uuid().nullable(),
  variant: z.enum(MEDIA_VARIANTS).nullable(),
  bytes: z.number().int().positive(),
  servedAt: z.iso.datetime(),
  ...base,
});
export type DeliveryServedMessage = z.infer<typeof deliveryServedMessageSchema>;

export const queueMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('media.uploaded'), mediaId: z.uuid(), ...base }),
  z.object({ type: z.literal('media.delete'), mediaId: z.uuid(), ...base }),
  z.object({ type: z.literal('gallery.delete'), galleryId: z.uuid(), ...base }),
  /**
   * A gallery's access-relevant fields changed (publish, password, expiry, suspension, deletion).
   * The worker re-reads the gallery and rewrites its KV access state (ADR-001); idempotent.
   */
  z.object({ type: z.literal('gallery.access_changed'), galleryId: z.uuid(), ...base }),
  z.object({ type: z.literal('archive.build'), jobId: z.uuid(), ...base }),
  z.object({ type: z.literal('guest.expire'), guestSessionId: z.uuid(), ...base }),
  deliveryServedMessageSchema,
]);
export type QueueMessage = z.infer<typeof queueMessageSchema>;
