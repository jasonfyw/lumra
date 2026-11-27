'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorMediaItem, GalleryDetail } from '@lumra/contracts';
import { PREVIEWABLE_TYPES, type BridgedUpload, type UploadBridge } from '@/components/upload';
import type { UploadState } from '@/lib/upload';

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

/** What the uploader on this page knows about one photo (ahead of the editor's poll). */
export interface LocalUpload {
  state: UploadState;
  percent: number;
  errorCode: string | null;
}

export type TilePhase =
  'uploading' | 'finishing' | 'ready' | 'failed' | 'upload_failed' | 'removing';

/**
 * The phase a tile presents: server terminal states win; the local upload state only moves a
 * tile forward (bytes are in storage → "finishing"), never back.
 */
export function tilePhase(item: EditorMediaItem, local?: LocalUpload): TilePhase {
  if (item.status === 'failed') return 'failed';
  if (item.status === 'deleting' || item.status === 'deleted') return 'removing';
  if (item.status === 'ready') return 'ready';
  if (local?.state === 'failed') {
    return local.errorCode === 'processing_failed' ? 'failed' : 'upload_failed';
  }
  if (
    local?.state === 'uploaded' ||
    local?.state === 'processing' ||
    local?.state === 'ready' ||
    item.status === 'uploaded' ||
    item.status === 'processing'
  ) {
    return 'finishing';
  }
  return 'uploading';
}

/**
 * Object URLs for files the uploader on this page still holds, keyed by media id, plus the
 * bridge the uploader reports through and the uploader's per-photo state. `onUnknown` fires once
 * per media id the editor's list doesn't contain yet (a new upload), so the editor can refetch
 * and start polling it; `onAdvance` fires when a photo's bytes finish uploading or its
 * processing finishes, so the editor can refresh sooner than its poll.
 */
export function useLocalPreviews(
  knownIds: ReadonlySet<string>,
  onUnknown: () => void,
  onAdvance: () => void = () => undefined,
): {
  bridge: UploadBridge;
  previews: ReadonlyMap<string, string>;
  local: ReadonlyMap<string, LocalUpload>;
  release: (mediaId: string) => void;
} {
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [local, setLocal] = useState<ReadonlyMap<string, LocalUpload>>(() => new Map());
  const urls = useRef(new Map<string, string>());
  const locals = useRef(new Map<string, LocalUpload>());
  const released = useRef(new Set<string>());
  const announced = useRef(new Set<string>());
  const latest = useRef({ knownIds, onUnknown, onAdvance });
  useEffect(() => {
    latest.current = { knownIds, onUnknown, onAdvance };
  });

  const bridge = useMemo<UploadBridge>(
    () => ({
      report(uploads: readonly BridgedUpload[]) {
        let added = false;
        let unknown = false;
        let advance = false;
        let localChanged = false;
        for (const upload of uploads) {
          if (!latest.current.knownIds.has(upload.mediaId)) {
            if (!announced.current.has(upload.mediaId)) unknown = true;
            announced.current.add(upload.mediaId);
          }
          const prev = locals.current.get(upload.mediaId);
          if (
            !prev ||
            prev.state !== upload.state ||
            prev.errorCode !== upload.errorCode ||
            Math.floor(prev.percent / 5) !== Math.floor(upload.percent / 5)
          ) {
            locals.current.set(upload.mediaId, {
              state: upload.state,
              percent: upload.percent,
              errorCode: upload.errorCode,
            });
            localChanged = true;
          }
          if (
            prev &&
            prev.state !== upload.state &&
            (upload.state === 'ready' || upload.state === 'uploaded')
          ) {
            advance = true;
          }
          if (
            released.current.has(upload.mediaId) ||
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
        if (localChanged) setLocal(new Map(locals.current));
        if (unknown) latest.current.onUnknown();
        if (advance) latest.current.onAdvance();
      },
    }),
    [],
  );

  /** The remote thumbnail is on screen: drop the local blob and never recreate it. */
  const release = useCallback((mediaId: string) => {
    released.current.add(mediaId);
    const url = urls.current.get(mediaId);
    if (url === undefined) return;
    URL.revokeObjectURL(url);
    urls.current.delete(mediaId);
    setPreviews(new Map(urls.current));
  }, []);

  useEffect(() => {
    const owned = urls.current;
    return () => {
      for (const url of owned.values()) URL.revokeObjectURL(url);
      owned.clear();
    };
  }, []);

  return { bridge, previews, local, release };
}
