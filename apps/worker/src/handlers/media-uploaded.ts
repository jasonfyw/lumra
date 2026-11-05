import { DERIVATIVE_WIDTHS, IMAGE_VALIDATION, UPLOAD_LIMITS } from '@lumra/config';
import type { QueueMessage } from '@lumra/contracts';
import type { CompletedVariant, MediaPipelineRepository } from '@lumra/db';
import { assertTransition, MEDIA_TRANSITIONS } from '@lumra/domain';
import { assertStorageKey, derivativeObjectKey, isPreviewVariant, sniffImage } from '@lumra/media';
import type { ProcessorClient } from '../processor-client';
import type { Logger } from '../log';

/** Narrow views of the R2 bindings so tests can use in-memory fakes. */
export interface OriginalsStore {
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
}

export interface DerivativesStore {
  put(
    key: string,
    value: Uint8Array,
    options: { httpMetadata: { contentType: string; cacheControl: string } },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

export interface MediaUploadedDeps {
  repo: MediaPipelineRepository;
  originals: OriginalsStore;
  derivatives: DerivativesStore;
  processor: ProcessorClient;
  log: Logger;
}

export type MediaUploadedOutcome =
  | 'ready'
  | 'already_ready'
  | 'already_failed'
  | 'skipped_missing'
  | 'skipped_deleted'
  | 'skipped_not_uploaded'
  | 'discarded_deleted'
  | 'rejected';

/** Retryable condition the queue should back off on (e.g. original not visible yet). */
export class TransientJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientJobError';
  }
}

type MediaUploadedMessage = Extract<QueueMessage, { type: 'media.uploaded' }>;

/**
 * `media.uploaded` consumer (T12, FR-M05/M06). Idempotent under at-least-once delivery:
 * redeliveries of a `ready`/`failed`/deleted media are acked without work, and a redelivery
 * while `processing` (crash, retry) simply re-runs the pipeline — object keys and variant rows
 * are deterministic, so a second run overwrites the first with identical results.
 *
 * Returns the outcome for logging; throws to make the queue retry with backoff.
 */
export async function handleMediaUploaded(
  message: MediaUploadedMessage,
  deps: MediaUploadedDeps,
): Promise<MediaUploadedOutcome> {
  const { repo, originals, derivatives, processor, log } = deps;
  const ctx = { mediaId: message.mediaId, traceId: message.traceId };

  const media = await repo.getForProcessing(message.mediaId);
  if (!media) return 'skipped_missing';
  if (media.deleted || media.status === 'deleting' || media.status === 'deleted') {
    return 'skipped_deleted';
  }
  if (media.status === 'ready') return 'already_ready';
  if (media.status === 'failed') return 'already_failed';
  if (media.status === 'reserved' || media.status === 'uploading') {
    // Finalize writes the outbox row in the same transaction as `uploaded`, so this means a
    // stale/replayed message for an upload that was re-opened; the next finalize re-enqueues.
    log('warn', 'media.uploaded for media that is not uploaded', { ...ctx, status: media.status });
    return 'skipped_not_uploaded';
  }
  if (media.status === 'uploaded')
    assertTransition('media', MEDIA_TRANSITIONS, 'uploaded', 'processing');
  if (!(await repo.markProcessing(media.id))) {
    // Lost a race with a delete (or another state change) between the read and the update.
    return 'skipped_deleted';
  }

  const reject = async (code: Parameters<MediaPipelineRepository['markFailed']>[1]) => {
    await repo.markFailed(media.id, code);
    log('warn', 'media rejected', { ...ctx, code });
    return 'rejected' as const;
  };

  // Authoritative type check on the stored bytes (T11): the client-side sniff is advisory.
  assertStorageKey(media.originalKey);
  const head = await originals.get(media.originalKey, {
    range: { offset: 0, length: IMAGE_VALIDATION.sniffBytes },
  });
  if (!head) throw new TransientJobError('original object not found');
  if (head.size > UPLOAD_LIMITS.maxPhotoBytes) return reject('file_too_large');
  if (head.size === 0) return reject('empty_file');
  const sniffed = sniffImage(new Uint8Array(await head.arrayBuffer()));
  if (!sniffed.ok) return reject(sniffed.code);

  const original = await originals.get(media.originalKey);
  if (!original) throw new TransientJobError('original object not found');
  const result = await processor.process({
    mediaId: media.id,
    expectedMime: sniffed.mime,
    widths: DERIVATIVE_WIDTHS,
    traceId: message.traceId,
    body: original.body,
    byteSize: original.size,
  });
  if (!result.ok) return reject(result.code);

  // Derivatives are written before the DB commit; if the commit is discarded we delete them.
  const variants: CompletedVariant[] = [];
  const written: string[] = [];
  try {
    for (const file of result.files) {
      if (!isPreviewVariant(file.variant)) throw new TransientJobError('unexpected variant');
      const objectKey = derivativeObjectKey(media.galleryId, media.id, file.variant);
      await derivatives.put(objectKey, file.bytes, {
        httpMetadata: {
          contentType: file.mime,
          // Keys change with the pipeline version, so objects are immutable (ADR-001 caching).
          cacheControl: 'private, max-age=31536000, immutable',
        },
      });
      written.push(objectKey);
      variants.push({
        variant: file.variant,
        objectKey,
        mime: file.mime,
        width: file.width,
        height: file.height,
        byteSize: file.byteSize,
      });
    }
  } catch (error) {
    // Leave no partial set behind for a media whose row never pointed at it.
    await derivatives.delete(written).catch(() => {});
    throw error;
  }

  const committed = await repo.complete({
    mediaId: media.id,
    mime: result.manifest.source.mime,
    width: result.manifest.source.width,
    height: result.manifest.source.height,
    orientation: result.manifest.source.orientation,
    takenAt: result.manifest.source.takenAt,
    variants,
  });

  if (committed.status === 'discarded') {
    // Deleted (or otherwise moved on) while we were processing: write nothing, remove what we
    // just uploaded. A failed delete leaves orphans for the T13 R2 sweep, never DB rows.
    try {
      await derivatives.delete(written);
    } catch {
      log('error', 'failed to delete discarded derivatives', { ...ctx, count: written.length });
    }
    log('info', 'processing result discarded', { ...ctx, reason: committed.reason });
    return 'discarded_deleted';
  }

  if (committed.staleObjectKeys.length > 0) {
    // Objects from an older pipeline version that no row references any more.
    await derivatives.delete(committed.staleObjectKeys).catch(() => {
      log('warn', 'failed to delete stale derivatives', { ...ctx });
    });
  }
  return 'ready';
}
