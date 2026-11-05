import { describe, expect, it } from 'vitest';
import { galleryAccessSnapshot, toPublicMediaStatus } from './index';

const now = new Date('2026-11-05T12:00:00.000Z');
const published = {
  status: 'published' as const,
  deletedAt: null,
  accessVersion: 3,
  expiresAt: null,
  deliverySuspended: false,
};

describe('galleryAccessSnapshot', () => {
  it('mirrors a published gallery', () => {
    expect(galleryAccessSnapshot(published, now)).toEqual({
      accessVersion: 3,
      deleted: false,
      expiresAt: null,
      deliverySuspended: false,
      updatedAt: now.toISOString(),
    });
    const expiresAt = new Date('2026-11-01T00:00:00.000Z');
    expect(galleryAccessSnapshot({ ...published, expiresAt }, now)?.expiresAt).toBe(
      expiresAt.toISOString(),
    );
    expect(
      galleryAccessSnapshot({ ...published, deliverySuspended: true }, now)?.deliverySuspended,
    ).toBe(true);
  });

  it('writes tombstones for deleted or missing galleries and nothing for drafts', () => {
    expect(galleryAccessSnapshot(null, now)?.deleted).toBe(true);
    expect(galleryAccessSnapshot({ ...published, status: 'deleted' }, now)?.deleted).toBe(true);
    expect(galleryAccessSnapshot({ ...published, deletedAt: now }, now)?.deleted).toBe(true);
    expect(galleryAccessSnapshot({ ...published, status: 'draft' }, now)).toBeNull();
  });
});

describe('toPublicMediaStatus', () => {
  it('collapses internal states', () => {
    expect(toPublicMediaStatus('ready')).toBe('ready');
    for (const s of ['reserved', 'uploading', 'uploaded', 'processing'] as const) {
      expect(toPublicMediaStatus(s)).toBe('pending');
    }
    expect(toPublicMediaStatus('failed')).toBe('unavailable');
  });
});
