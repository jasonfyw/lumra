import { describe, expect, it } from 'vitest';
import { queueMessageSchema, uploadIntentRequestSchema } from './index';

describe('uploadIntentRequestSchema', () => {
  const valid = {
    filename: 'IMG_0001.HEIC',
    mime: 'image/heic',
    size: 4_000_000,
    clientId: '6f1c1a5e-1d2b-4c3a-9e8f-0a1b2c3d4e5f',
  };

  it('accepts a supported photo', () => {
    expect(uploadIntentRequestSchema.parse(valid)).toEqual(valid);
  });

  it('rejects files over 50 MB and unsupported types', () => {
    expect(uploadIntentRequestSchema.safeParse({ ...valid, size: 50_000_001 }).success).toBe(false);
    expect(uploadIntentRequestSchema.safeParse({ ...valid, mime: 'video/mp4' }).success).toBe(
      false,
    );
  });
});

describe('queueMessageSchema', () => {
  it('rejects unknown message types', () => {
    expect(
      queueMessageSchema.safeParse({ type: 'media.transcode', traceId: 't', dedupeKey: 'd' })
        .success,
    ).toBe(false);
  });
});
