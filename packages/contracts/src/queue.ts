import { z } from 'zod';

/**
 * Queue messages carry IDs only — never secrets or file bytes (PRD §6.1).
 * `traceId` propagates the originating request ID for cross-runtime tracing.
 */
const base = { traceId: z.string(), dedupeKey: z.string() };

export const queueMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('media.uploaded'), mediaId: z.uuid(), ...base }),
  z.object({ type: z.literal('media.delete'), mediaId: z.uuid(), ...base }),
  z.object({ type: z.literal('gallery.delete'), galleryId: z.uuid(), ...base }),
  z.object({ type: z.literal('archive.build'), jobId: z.uuid(), ...base }),
  z.object({ type: z.literal('guest.expire'), guestSessionId: z.uuid(), ...base }),
]);
export type QueueMessage = z.infer<typeof queueMessageSchema>;
