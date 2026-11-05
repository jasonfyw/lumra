import { describe, expect, it } from 'vitest';
import type { PublicGalleryResponse, PublicMediaItem } from '@lumra/contracts';
import {
  addDownloads,
  addPreviews,
  cacheFromPayload,
  chunk,
  downloadNeeded,
  previewsNeeded,
  withUrls,
} from './media-urls';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, status: PublicMediaItem['status'] = 'ready'): PublicMediaItem => ({
  id: id(n),
  status,
  width: status === 'ready' ? 300 : null,
  height: status === 'ready' ? 200 : null,
  uploadOrder: n,
  filename: `p${n}.jpg`,
  variants: [],
});
const v = (url: string) => [{ width: 320, url }];
const now = 1_000_000;

describe('media URL cache', () => {
  it('seeds from the payload and applies URLs to ready items only', () => {
    const payload: PublicGalleryResponse = {
      gallery: {
        id: id(99),
        slug: 's',
        title: 't',
        coverMediaId: null,
        brandingVisible: true,
        contentVersion: 1,
      },
      items: [{ ...item(1), variants: v('/a') }, item(2), item(3, 'pending')],
      urlsExpireAt: new Date(now + 300_000).toISOString(),
    };
    const cache = cacheFromPayload(payload, now);
    const merged = withUrls(payload.items, cache, now);
    expect(merged.map((i) => i.variants.length)).toEqual([1, 0, 0]);
    expect(previewsNeeded(payload.items, cache, [id(1), id(2), id(3)], now)).toEqual([id(2)]);
  });

  it('re-mints when near expiry but keeps showing the old URL meanwhile', () => {
    const items = [item(1)];
    const cache = addPreviews(
      cacheFromPayload({ gallery: {} as never, items }, now),
      [{ id: id(1), variants: v('/old') }],
      now + 10_000,
    );
    expect(previewsNeeded(items, cache, [id(1)], now)).toEqual([id(1)]);
    expect(withUrls(items, cache, now + 60_000)[0]!.variants[0]!.url).toBe('/old');
  });

  it('hides expired download URLs', () => {
    const items = [item(1)];
    let cache = cacheFromPayload({ gallery: {} as never, items }, now);
    expect(downloadNeeded(cache, id(1), now)).toBe(true);
    cache = addDownloads(cache, [{ id: id(1), downloadUrl: '/dl' }], now + 300_000);
    expect(downloadNeeded(cache, id(1), now)).toBe(false);
    expect(withUrls(items, cache, now)[0]!.downloadUrl).toBe('/dl');
    expect(withUrls(items, cache, now + 300_001)[0]!.downloadUrl).toBeUndefined();
  });

  it('chunks batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
