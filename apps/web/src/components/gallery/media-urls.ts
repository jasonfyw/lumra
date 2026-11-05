import { PUBLIC_GALLERY } from '@lumra/config';
import type { PublicGalleryResponse, PublicMediaItem, PublicMediaVariant } from '@lumra/contracts';

/**
 * Client-side cache of short-lived gateway URLs for the public gallery (ADR-001 token minting
 * strategy). Pure functions so the merge/refresh rules are unit-testable.
 *
 * - A tile keeps the URL it was first rendered with, even past expiry: swapping `src` would
 *   re-download bytes the browser already shows. URLs are re-minted only when an item is
 *   (re)needed — scrolled into view or opened — and its URL is missing or about to expire.
 * - Download URLs are separate (minted on demand for the lightbox item).
 */
export interface UrlEntry<T> {
  value: T;
  expiresAt: number;
}

export interface MediaUrlCache {
  previews: ReadonlyMap<string, UrlEntry<PublicMediaVariant[]>>;
  downloads: ReadonlyMap<string, UrlEntry<string>>;
}

export const emptyUrlCache = (): MediaUrlCache => ({ previews: new Map(), downloads: new Map() });

/** Seeds the cache with the URLs minted into a page payload. */
export function cacheFromPayload(payload: PublicGalleryResponse, now: number): MediaUrlCache {
  const cache = emptyUrlCache();
  return addPreviews(
    cache,
    payload.items
      .filter((i) => i.variants.length > 0)
      .map((i) => ({ id: i.id, variants: i.variants })),
    payload.urlsExpireAt ? Date.parse(payload.urlsExpireAt) : now,
  );
}

export function addPreviews(
  cache: MediaUrlCache,
  minted: readonly { id: string; variants: PublicMediaVariant[] }[],
  expiresAt: number,
): MediaUrlCache {
  if (minted.length === 0) return cache;
  const previews = new Map(cache.previews);
  for (const m of minted) {
    if (m.variants.length > 0) previews.set(m.id, { value: m.variants, expiresAt });
  }
  return { ...cache, previews };
}

export function addDownloads(
  cache: MediaUrlCache,
  minted: readonly { id: string; downloadUrl?: string }[],
  expiresAt: number,
): MediaUrlCache {
  const downloads = new Map(cache.downloads);
  for (const m of minted) {
    if (m.downloadUrl) downloads.set(m.id, { value: m.downloadUrl, expiresAt });
  }
  return { ...cache, downloads };
}

const isFresh = (entry: UrlEntry<unknown> | undefined, now: number) =>
  entry !== undefined && entry.expiresAt - now > PUBLIC_GALLERY.urlRefreshLeadMs;

/** Ready ids among `ids` whose preview URLs are missing or about to expire. */
export function previewsNeeded(
  items: readonly PublicMediaItem[],
  cache: MediaUrlCache,
  ids: readonly string[],
  now: number,
): string[] {
  const ready = new Set(items.filter((i) => i.status === 'ready').map((i) => i.id));
  return ids.filter((id) => ready.has(id) && !isFresh(cache.previews.get(id), now));
}

export function downloadNeeded(cache: MediaUrlCache, id: string, now: number): boolean {
  return !isFresh(cache.downloads.get(id), now);
}

/** Items with cached URLs applied (non-ready items never carry URLs). */
export function withUrls(items: readonly PublicMediaItem[], cache: MediaUrlCache, now: number) {
  return items.map((item): PublicMediaItem => {
    if (item.status !== 'ready') return item;
    const preview = cache.previews.get(item.id);
    const download = cache.downloads.get(item.id);
    // An expired download URL would 401 at the gateway; hide the link until it's re-minted.
    const downloadUrl = download && download.expiresAt > now ? download.value : undefined;
    return {
      ...item,
      variants: preview?.value ?? [],
      ...(downloadUrl ? { downloadUrl } : {}),
    };
  });
}

export function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}
