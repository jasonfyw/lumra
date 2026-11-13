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
 * Consumed by usage-ledger ingestion (T27) from the `lumra-usage-*` queue: the key becomes the
 * ledger `source_id` (UNIQUE with the metric, at most 200 characters), so it must stay stable.
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
  dedupeKey: z.string().min(1).max(200),
});
export type DeliveryServedMessage = z.infer<typeof deliveryServedMessageSchema>;

/**
 * Account emails (PRD §9.4 transition notices, T33; spend-cap alerts, T32). The payload names the
 * account and a template only — the worker looks the address up at send time, so no personal
 * data sits in the outbox or the queue. `data` holds small non-personal template values.
 */
export const EMAIL_TEMPLATES = [
  'pro_activated',
  'payment_failed',
  'payment_recovered',
  'delivery_suspended',
  'subscription_ended',
  'delivery_paused',
  'spend_cap_alert',
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export const emailSendMessageSchema = z.object({
  type: z.literal('email.send'),
  accountId: z.uuid(),
  template: z.enum(EMAIL_TEMPLATES),
  data: z.record(z.string(), z.union([z.string().max(200), z.number()])).default({}),
  ...base,
});
export type EmailSendMessage = z.infer<typeof emailSendMessageSchema>;

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
  emailSendMessageSchema,
]);
export type QueueMessage = z.infer<typeof queueMessageSchema>;

/**
 * Transactional outbox mapping (PRD §6.3, T12). The web app inserts a `job_outbox` row in the
 * same transaction as the state change (e.g. upload finalize → `media.uploaded`); the worker
 * relay publishes it to the `JOBS` queue. `event_name` is the message `type`, `dedupe_key` the
 * message `dedupeKey`, and `payload` holds the remaining message fields (`traceId` optional).
 */
export interface OutboxRecord {
  eventName: QueueMessage['type'];
  aggregateId: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
}

export function toOutboxRecord(message: QueueMessage, aggregateId: string): OutboxRecord {
  const { type, dedupeKey, ...payload } = message;
  return { eventName: type, aggregateId, payload, dedupeKey };
}

export interface OutboxRowLike {
  id: string;
  eventName: string;
  payload: unknown;
  dedupeKey: string | null;
}

/** Builds the queue message for an outbox row. Throws a ZodError if the row is malformed. */
export function outboxRowToQueueMessage(row: OutboxRowLike): QueueMessage {
  const payload =
    row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  return queueMessageSchema.parse({
    traceId: `outbox:${row.id}`,
    ...payload,
    type: row.eventName,
    dedupeKey: row.dedupeKey ?? `outbox:${row.id}`,
  });
}
