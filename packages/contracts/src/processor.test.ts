import { describe, expect, it } from 'vitest';
import {
  outboxRowToQueueMessage,
  processManifestSchema,
  processRequestParamsSchema,
  processorErrorBodySchema,
  toOutboxRecord,
} from './index';

const mediaId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('processor contract', () => {
  it('accepts only known derivative widths', () => {
    const base = { mediaId, expectedMime: 'image/heic', traceId: 'req-1' };
    expect(processRequestParamsSchema.safeParse({ ...base, widths: [320, 2048] }).success).toBe(
      true,
    );
    expect(processRequestParamsSchema.safeParse({ ...base, widths: [300] }).success).toBe(false);
    expect(processRequestParamsSchema.safeParse({ ...base, widths: [] }).success).toBe(false);
  });

  it('validates the manifest shape', () => {
    const manifest = {
      mediaId,
      source: { mime: 'image/jpeg', width: 4000, height: 3000, orientation: 6, takenAt: null },
      encoding: { format: 'webp', quality: 80, pipelineVersion: 1 },
      variants: [
        {
          variant: 'w320',
          field: 'w320',
          mime: 'image/webp',
          width: 320,
          height: 240,
          byteSize: 1234,
        },
      ],
    };
    expect(processManifestSchema.parse(manifest)).toEqual(manifest);
    expect(processManifestSchema.safeParse({ ...manifest, variants: [] }).success).toBe(false);
  });

  it('types error bodies with known codes only', () => {
    expect(
      processorErrorBodySchema.safeParse({
        error: { code: 'too_many_pixels', retryable: false, message: 'x' },
      }).success,
    ).toBe(true);
    expect(
      processorErrorBodySchema.safeParse({ error: { code: 'nope', retryable: false, message: '' } })
        .success,
    ).toBe(false);
  });
});

describe('outbox mapping', () => {
  it('round-trips a queue message through an outbox row', () => {
    const message = {
      type: 'media.uploaded' as const,
      mediaId,
      traceId: 'req-9',
      dedupeKey: `media.uploaded:${mediaId}`,
    };
    const record = toOutboxRecord(message, mediaId);
    expect(record).toEqual({
      eventName: 'media.uploaded',
      aggregateId: mediaId,
      payload: { mediaId, traceId: 'req-9' },
      dedupeKey: `media.uploaded:${mediaId}`,
    });
    expect(
      outboxRowToQueueMessage({
        id: 'row-1',
        eventName: record.eventName,
        payload: record.payload,
        dedupeKey: record.dedupeKey,
      }),
    ).toEqual(message);
  });

  it('falls back to the row id for trace and dedupe keys', () => {
    expect(
      outboxRowToQueueMessage({
        id: 'row-2',
        eventName: 'media.uploaded',
        payload: { mediaId },
        dedupeKey: null,
      }),
    ).toEqual({
      type: 'media.uploaded',
      mediaId,
      traceId: 'outbox:row-2',
      dedupeKey: 'outbox:row-2',
    });
  });

  it('rejects malformed rows and never lets the payload override the type', () => {
    expect(() =>
      outboxRowToQueueMessage({
        id: 'r',
        eventName: 'media.uploaded',
        payload: { mediaId: 'x' },
        dedupeKey: null,
      }),
    ).toThrow();
    const message = outboxRowToQueueMessage({
      id: 'r',
      eventName: 'media.delete',
      payload: { mediaId, type: 'media.uploaded' },
      dedupeKey: 'k',
    });
    expect(message.type).toBe('media.delete');
  });
});
