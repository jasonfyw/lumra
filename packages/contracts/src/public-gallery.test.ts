import { describe, expect, it } from 'vitest';
import { publicGalleryResponseSchema, publicMediaItemSchema } from './index';

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

  it('requires variants and dimensions only for ready items', () => {
    expect(publicMediaItemSchema.safeParse({ ...ready, variants: [] }).success).toBe(false);
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
