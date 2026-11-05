import { describe, expect, it } from 'vitest';
import {
  mediaTokensRequestSchema,
  publicGalleryLookupSchema,
  publicGalleryResponseSchema,
  publicMediaItemSchema,
  unlockGalleryRequestSchema,
} from './index';

const ready = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'ready',
  width: 6000,
  height: 4000,
  uploadOrder: 0,
  filename: 'IMG_0001.jpg',
  variants: [{ width: 320, url: 'https://media.example.workers.dev/v/abc?t=x' }],
  downloadUrl: 'https://media.example.workers.dev/o/abc?t=x',
};

const pending = {
  id: ready.id,
  uploadOrder: 0,
  filename: ready.filename,
  status: 'pending',
  width: null,
  height: null,
  variants: [],
};

describe('publicMediaItemSchema', () => {
  it('accepts ready, pending and unavailable items', () => {
    expect(publicMediaItemSchema.parse(ready)).toEqual(ready);
    expect(publicMediaItemSchema.safeParse(pending).success).toBe(true);
    expect(publicMediaItemSchema.safeParse({ ...pending, status: 'unavailable' }).success).toBe(
      true,
    );
  });

  it('never exposes internal statuses to recipients', () => {
    expect(publicMediaItemSchema.safeParse({ ...ready, status: 'failed' }).success).toBe(false);
    expect(publicMediaItemSchema.safeParse({ ...ready, status: 'processing' }).success).toBe(false);
  });

  it('requires dimensions for ready items and URLs only on ready items', () => {
    // Ready items may arrive without URLs; the client mints them lazily (ADR-001).
    expect(publicMediaItemSchema.safeParse({ ...ready, variants: [] }).success).toBe(true);
    expect(publicMediaItemSchema.safeParse({ ...ready, width: null }).success).toBe(false);
    expect(publicMediaItemSchema.safeParse({ ...ready, status: 'pending' }).success).toBe(false);
  });

  it('rejects script and protocol-relative URLs', () => {
    for (const url of ['javascript:alert(1)', '//evil.example/x', 'data:image/svg+xml,x']) {
      expect(publicMediaItemSchema.safeParse({ ...ready, downloadUrl: url }).success).toBe(false);
    }
    expect(publicMediaItemSchema.safeParse({ ...ready, downloadUrl: '/dev/x' }).success).toBe(true);
  });
});

describe('publicGalleryResponseSchema', () => {
  const gallery = {
    id: '00000000-0000-4000-8000-0000000000aa',
    slug: 'k3x9-autumn',
    title: 'Autumn',
    coverMediaId: null,
    brandingVisible: true,
    contentVersion: 3,
  };

  it('accepts a gallery with items', () => {
    expect(publicGalleryResponseSchema.safeParse({ gallery, items: [ready] }).success).toBe(true);
  });

  it('caps the item count at the gallery limit', () => {
    const items = Array.from({ length: 2_001 }, () => ready);
    expect(publicGalleryResponseSchema.safeParse({ gallery, items }).success).toBe(false);
  });
});

describe('public gallery endpoint contracts', () => {
  it('a locked gallery reveals nothing but the lock', () => {
    expect(publicGalleryLookupSchema.parse({ passwordRequired: true })).toEqual({
      passwordRequired: true,
    });
    // Extra fields are stripped, so a locked payload can never carry gallery metadata.
    expect(
      publicGalleryLookupSchema.parse({ passwordRequired: true, title: 'Secret' } as never),
    ).toEqual({ passwordRequired: true });
  });

  it('bounds unlock passwords and media-token batches', () => {
    expect(unlockGalleryRequestSchema.safeParse({ password: '' }).success).toBe(false);
    expect(unlockGalleryRequestSchema.safeParse({ password: 'x'.repeat(257) }).success).toBe(false);
    const id = '00000000-0000-4000-8000-000000000001';
    expect(mediaTokensRequestSchema.safeParse({ mediaIds: [id], action: 'preview' }).success).toBe(
      true,
    );
    expect(
      mediaTokensRequestSchema.safeParse({ mediaIds: [id, id], action: 'preview' }).success,
    ).toBe(false);
    expect(mediaTokensRequestSchema.safeParse({ mediaIds: [id], action: 'archive' }).success).toBe(
      false,
    );
    const many = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(mediaTokensRequestSchema.safeParse({ mediaIds: many, action: 'preview' }).success).toBe(
      false,
    );
  });
});
