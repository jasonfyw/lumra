'use client';

import { createContext } from 'react';
import type { UploadState } from '@/lib/upload';

/** MIME types every browser can render from a local blob (HEIC is not one of them). */
export const PREVIEWABLE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** One upload the uploader knows a server media id for. */
export interface BridgedUpload {
  mediaId: string;
  state: UploadState;
  /** The selected file while this page still holds it (null after a reload). */
  file: File | null;
}

/**
 * Optional link from a mounted `GalleryUploader` to the page around it (the owner editor):
 * the uploader reports its items so the editor can show a local preview under a tile's
 * processing overlay and pick up newly created photos. Absent on `/new`.
 */
export interface UploadBridge {
  report(uploads: readonly BridgedUpload[]): void;
}

export const UploadBridgeContext = createContext<UploadBridge | null>(null);
