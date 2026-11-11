import { ARCHIVE_LIMITS } from '@lumra/config';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_STATUSES,
  archivePartDownloadName,
  archiveProgressPct,
  archiveSourceFingerprint,
  planArchive,
  toPublicArchiveStatus,
  type ArchiveSourceItem,
} from './archive';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, extra: Partial<ArchiveSourceItem> = {}): ArchiveSourceItem => ({
  mediaId: uuid(n),
  filename: `IMG_${n}.jpg`,
  mime: 'image/jpeg',
  bytes: 1_000_000,
  ...extra,
});

describe('planArchive', () => {
  it('a 2,000-item gallery yields at least 4 parts of ≤ 500 items (T24 AC)', () => {
    const plan = planArchive(Array.from({ length: 2000 }, (_, i) => item(i)));
    expect(plan.parts.length).toBeGreaterThanOrEqual(4);
    expect(plan.parts.every((p) => p.itemCount <= ARCHIVE_LIMITS.maxItemsPerPart)).toBe(true);
    expect(plan.itemCount).toBe(2000);
    expect(plan.parts.map((p) => p.partNo)).toEqual([1, 2, 3, 4]);
  });

  it('splits on the 2 GB byte bound, keeping display order', () => {
    // 30 MB photos: 66 fit in 2 GB (1.98 GB), the 67th starts a new part.
    const items = Array.from({ length: 100 }, (_, i) => item(i, { bytes: 30_000_000 }));
    const plan = planArchive(items);
    expect(plan.parts.map((p) => p.itemCount)).toEqual([66, 34]);
    expect(plan.parts[0]!.sourceBytes).toBe(66 * 30_000_000);
    expect(plan.parts.flatMap((p) => p.entries.map((e) => e.mediaId))).toEqual(
      items.map((i) => i.mediaId),
    );
    expect(plan.totalBytes).toBe(100 * 30_000_000);
  });

  it('gives an oversized item its own part instead of failing', () => {
    const plan = planArchive([item(1, { bytes: 10 }), item(2, { bytes: 50 }), item(3)], {
      maxItemsPerPart: 10,
      maxBytesPerPart: 40,
    });
    expect(plan.parts.map((p) => p.entries.map((e) => e.mediaId))).toEqual([
      [uuid(1)],
      [uuid(2)],
      [uuid(3)],
    ]);
  });

  it('sanitizes traversal names and de-duplicates across all parts (FR-D02, PRD §11)', () => {
    const plan = planArchive(
      [
        item(1, { filename: '../../etc/passwd' }),
        item(2, { filename: '..\\..\\boot.ini' }),
        item(3, { filename: 'a.jpg' }),
        item(4, { filename: 'A.JPG' }),
        item(5, { filename: 'a.jpg' }),
        item(6, { filename: '', mime: 'image/heic' }),
        item(7, { filename: '...', mime: 'image/heic' }),
      ],
      { maxItemsPerPart: 2, maxBytesPerPart: 10_000_000_000 },
    );
    const names = plan.parts.flatMap((p) => p.entries.map((e) => e.name));
    expect(names).toEqual([
      'passwd.jpg',
      'boot.ini',
      'a.jpg',
      'A (2).JPG',
      'a (3).jpg',
      'photo.heic',
      'photo (2).heic',
    ]);
    for (const name of names) {
      expect(name).not.toMatch(/[\\/]/);
      expect(name.startsWith('.')).toBe(false);
    }
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });

  it('is deterministic and never exceeds the bounds (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ name: fc.string(), bytes: fc.integer({ min: 0, max: 900 }) }), {
          maxLength: 60,
        }),
        fc.integer({ min: 1, max: 7 }),
        fc.integer({ min: 900, max: 3000 }),
        (rows, maxItemsPerPart, maxBytesPerPart) => {
          const items = rows.map((r, i) => item(i, { filename: r.name, bytes: r.bytes }));
          const a = planArchive(items, { maxItemsPerPart, maxBytesPerPart });
          const b = planArchive(items, { maxItemsPerPart, maxBytesPerPart });
          expect(a).toEqual(b);
          for (const part of a.parts) {
            expect(part.itemCount).toBeLessThanOrEqual(maxItemsPerPart);
            expect(part.sourceBytes).toBeLessThanOrEqual(maxBytesPerPart);
            expect(part.itemCount).toBeGreaterThan(0);
          }
          const names = a.parts.flatMap((p) => p.entries.map((e) => e.name.toLowerCase()));
          expect(new Set(names).size).toBe(items.length);
        },
      ),
    );
  });

  it('rejects invalid sizes', () => {
    expect(() => planArchive([item(1, { bytes: -1 })])).toThrow(RangeError);
    expect(() => planArchive([item(1)], { maxItemsPerPart: 0, maxBytesPerPart: 1 })).toThrow();
  });
});

describe('archiveSourceFingerprint', () => {
  it('changes with membership, order and names', async () => {
    const base = planArchive([item(1), item(2)]);
    const same = await archiveSourceFingerprint(planArchive([item(1), item(2)]));
    expect(await archiveSourceFingerprint(base)).toBe(same);
    expect(same).toMatch(/^[a-f0-9]{64}$/);
    const others = await Promise.all([
      archiveSourceFingerprint(planArchive([item(2), item(1)])),
      archiveSourceFingerprint(planArchive([item(1)])),
      archiveSourceFingerprint(planArchive([item(1), item(2, { filename: 'x.jpg' })])),
    ]);
    for (const other of others) expect(other).not.toBe(same);
  });
});

describe('archivePartDownloadName', () => {
  it('names single and split archives after the gallery', () => {
    expect(archivePartDownloadName('Autumn wedding', 1, 1)).toBe('Autumn wedding.zip');
    expect(archivePartDownloadName('Autumn wedding', 2, 4)).toBe(
      'Autumn wedding (part 2 of 4).zip',
    );
    expect(archivePartDownloadName('  ', 1, 1)).toBe('Lumra photos.zip');
    expect(archivePartDownloadName('../../x/Trip.zip', 1, 2)).toBe('Trip (part 1 of 2).zip');
  });
});

describe('toPublicArchiveStatus / archiveProgressPct', () => {
  it('maps every internal status', () => {
    expect(ARCHIVE_STATUSES.map(toPublicArchiveStatus)).toEqual([
      'preparing',
      'preparing',
      'processing',
      'ready',
      'failed',
      'expired',
      'expired',
    ]);
  });

  it('never reports 100 % before the job is ready', () => {
    expect(archiveProgressPct(0, 0)).toBe(0);
    expect(archiveProgressPct(50, 200)).toBe(25);
    expect(archiveProgressPct(200, 200)).toBe(99);
    expect(archiveProgressPct(-5, 200)).toBe(0);
  });
});
