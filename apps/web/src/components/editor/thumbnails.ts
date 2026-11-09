'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GalleryDetail } from '@lumra/contracts';
import { PREVIEWABLE_TYPES, type BridgedUpload, type UploadBridge } from '@/components/upload';

/**
 * Editor thumbnails (owner-scoped gateway URLs, ADR-001) and local upload previews.
 *
 * Gateway URLs live ≤ 5 min and every editor response mints fresh ones. A tile keeps the URL it
 * first rendered with (swapping `src` would re-download bytes already on screen) unless that
 * image failed to load — typically an expired token on a lazily loaded tile — in which case the
 * next response's URL replaces it.
 */
export function mergeThumbnails(
  prev: GalleryDetail,
  next: GalleryDetail,
  stale: ReadonlySet<string> = new Set(),
): GalleryDetail {
  const previous = new Map(prev.items.map((i) => [i.id, i.thumbnailUrl]));
  return {
    ...next,
    items: next.items.map((item) => {
      const kept = previous.get(item.id);
      return kept && item.thumbnailUrl && !stale.has(item.id)
        ? { ...item, thumbnailUrl: kept }
        : item;
    }),
  };
}

/** Minimum gap between refetches triggered by one tile's failing thumbnail. */
export const THUMBNAIL_RETRY_MS = 60_000;

/**
 * Object URLs for files the uploader on this page still holds, keyed by media id, plus the
 * bridge the uploader reports through. `onUnknown` fires once per media id the editor's list
 * doesn't contain yet (a new upload), so the editor can refetch and start polling it.
 */
export function useLocalPreviews(
  knownIds: ReadonlySet<string>,
  onUnknown: () => void,
): { bridge: UploadBridge; previews: ReadonlyMap<string, string> } {
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(() => new Map());
  const urls = useRef(new Map<string, string>());
  const announced = useRef(new Set<string>());
  const latest = useRef({ knownIds, onUnknown });
  useEffect(() => {
    latest.current = { knownIds, onUnknown };
  });

  const bridge = useMemo<UploadBridge>(
    () => ({
      report(uploads: readonly BridgedUpload[]) {
        let added = false;
        let unknown = false;
        for (const upload of uploads) {
          if (!latest.current.knownIds.has(upload.mediaId)) {
            if (!announced.current.has(upload.mediaId)) unknown = true;
            announced.current.add(upload.mediaId);
          }
          if (
            urls.current.has(upload.mediaId) ||
            !upload.file ||
            !PREVIEWABLE_TYPES.has(upload.file.type) ||
            typeof URL.createObjectURL !== 'function'
          ) {
            continue;
          }
          urls.current.set(upload.mediaId, URL.createObjectURL(upload.file));
          added = true;
        }
        if (added) setPreviews(new Map(urls.current));
        if (unknown) latest.current.onUnknown();
      },
    }),
    [],
  );

  useEffect(() => {
    const owned = urls.current;
    return () => {
      for (const url of owned.values()) URL.revokeObjectURL(url);
      owned.clear();
    };
  }, []);

  return { bridge, previews };
}
