'use client';

import { PUBLIC_GALLERY } from '@lumra/config';
import {
  mediaTokensResponseSchema,
  publicGalleryLookupSchema,
  type PublicGalleryResponse,
} from '@lumra/contracts';
import { selectCover } from '@lumra/domain';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DownloadAllButton } from './download-all-button';
import { GalleryView } from './gallery-view';
import {
  addDownloads,
  addPreviews,
  cacheFromPayload,
  chunk,
  downloadNeeded,
  previewsNeeded,
  withUrls,
  type MediaUrlCache,
} from './media-urls';

export interface PublicGalleryProps {
  slug: string;
  initial: PublicGalleryResponse;
}

/** How often URLs for the open lightbox item are checked for refresh. */
const LIGHTBOX_REFRESH_MS = 30_000;
/** Visible-tile changes are coalesced into one mint request per frame burst. */
const MINT_DEBOUNCE_MS = 120;

/**
 * Recipient gallery container (`/g/[slug]`, T16/T20). Renders `GalleryView` from the server
 * payload and keeps it live:
 * - mints preview URLs for tiles as they become visible (≤ 100 ids per `media-tokens` call) and
 *   a download URL for the item open in the lightbox (refreshed before it expires);
 * - while any item is pending, polls the public endpoint (statuses only, `?urls=0`) every
 *   `PUBLIC_GALLERY.pollIntervalMs` so placeholders fill in without a refresh (PRD §14.2-3);
 * - if the gallery becomes locked, expired or gone, refreshes the route so the server renders
 *   the gate / expired / not-found page.
 */
export function PublicGallery({ slug, initial }: PublicGalleryProps) {
  const router = useRouter();
  const [payload, setPayload] = useState(initial);
  const [cache, setCache] = useState<MediaUrlCache>(() => cacheFromPayload(initial, Date.now()));
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const itemsRef = useRef(payload.items);
  itemsRef.current = payload.items;
  const inFlight = useRef(new Set<string>());
  const wanted = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVisible = useRef<string[]>([]);
  const api = `/api/v1/public/galleries/${encodeURIComponent(slug)}`;

  const handleGone = useCallback(
    (status: number) => {
      if (status === 401 || status === 404 || status === 410) router.refresh();
    },
    [router],
  );

  const mint = useCallback(
    async (ids: string[], action: 'preview' | 'original') => {
      if (ids.length === 0) return;
      for (const id of ids) inFlight.current.add(`${action}:${id}`);
      try {
        for (const batch of chunk(ids, PUBLIC_GALLERY.maxMediaTokenIds)) {
          const res = await fetch(`${api}/media-tokens`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mediaIds: batch, action }),
            cache: 'no-store',
          });
          if (!res.ok) {
            handleGone(res.status);
            return;
          }
          const body = (await res.json()) as { data: unknown };
          const parsed = mediaTokensResponseSchema.safeParse(body.data);
          if (!parsed.success) return;
          const expiresAt = Date.parse(parsed.data.expiresAt);
          setCache((current) =>
            action === 'preview'
              ? addPreviews(current, parsed.data.items, expiresAt)
              : addDownloads(current, parsed.data.items, expiresAt),
          );
        }
      } catch {
        // Network blip: tiles stay as quiet skeletons and are retried when next needed.
      } finally {
        for (const id of ids) inFlight.current.delete(`${action}:${id}`);
      }
    },
    [api, handleGone],
  );

  /** Queue preview mints for `ids`; flushed after a short debounce. */
  const requestPreviews = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) wanted.current.add(id);
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const ids = [...wanted.current];
        wanted.current.clear();
        const needed = previewsNeeded(itemsRef.current, cacheRef.current, ids, Date.now()).filter(
          (id) => !inFlight.current.has(`preview:${id}`),
        );
        void mint(needed, 'preview');
      }, MINT_DEBOUNCE_MS);
    },
    [mint],
  );

  useEffect(
    () => () => {
      // Reset too: React StrictMode re-runs effects, and a stale handle would block flushes.
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  const onVisibleItemsChange = useCallback(
    (ids: string[]) => {
      lastVisible.current = ids;
      requestPreviews(ids);
    },
    [requestPreviews],
  );

  // After a poll, tiles that just became ready (and a new hero) need URLs too, even though the
  // set of visible ids didn't change.
  useEffect(() => {
    const cover = selectCover(payload.items, payload.gallery.coverMediaId);
    requestPreviews(cover ? [...lastVisible.current, cover.id] : lastVisible.current);
  }, [payload, requestPreviews]);

  // Lightbox: current + neighbours' previews, and the current item's download URL.
  const lightboxId = lightboxIndex === null ? null : (payload.items[lightboxIndex]?.id ?? null);
  useEffect(() => {
    if (lightboxIndex === null) return;
    const items = itemsRef.current;
    requestPreviews(
      [items[lightboxIndex - 1], items[lightboxIndex], items[lightboxIndex + 1]]
        .filter((i) => i !== undefined)
        .map((i) => i.id),
    );
    const current = items[lightboxIndex];
    if (
      current?.status === 'ready' &&
      downloadNeeded(cacheRef.current, current.id, Date.now()) &&
      !inFlight.current.has(`original:${current.id}`)
    ) {
      void mint([current.id], 'original');
    }
  }, [lightboxIndex, lightboxId, tick, mint, requestPreviews]);

  useEffect(() => {
    if (lightboxIndex === null) return;
    const id = setInterval(() => setTick((t) => t + 1), LIGHTBOX_REFRESH_MS);
    return () => clearInterval(id);
  }, [lightboxIndex]);

  // Poll statuses while anything is still pending.
  const anyPending = payload.items.some((i) => i.status === 'pending');
  useEffect(() => {
    if (!anyPending) return;
    let cancelled = false;
    const id = setInterval(async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const res = await fetch(`${api}?urls=0`, { cache: 'no-store' });
        if (cancelled) return;
        if (!res.ok) {
          handleGone(res.status);
          return;
        }
        const body = (await res.json()) as { data: unknown };
        const parsed = publicGalleryLookupSchema.safeParse(body.data);
        if (!parsed.success || cancelled) return;
        if ('passwordRequired' in parsed.data) {
          router.refresh();
          return;
        }
        setPayload(parsed.data);
      } catch {
        // Try again next interval.
      }
    }, PUBLIC_GALLERY.pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [anyPending, api, handleGone, router]);

  const items = useMemo(() => withUrls(payload.items, cache, Date.now()), [payload.items, cache]);
  const readyCount = useMemo(
    () => payload.items.filter((i) => i.status === 'ready').length,
    [payload.items],
  );

  return (
    <GalleryView
      gallery={payload.gallery}
      items={items}
      onVisibleItemsChange={onVisibleItemsChange}
      onLightboxIndexChange={setLightboxIndex}
      heroActions={<DownloadAllButton slug={slug} readyCount={readyCount} />}
    />
  );
}
