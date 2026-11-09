'use client';

import Link from 'next/link';
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { buttonClass } from '@/components/ui';
import { openDraftStore } from '@/lib/draft-store';
import {
  baseConcurrency,
  createUploadApi,
  detectMobile,
  UploadEngine,
  type ConnectionInfo,
  type UploadApi,
} from '@/lib/upload';
import { PHOTO_ACCEPT, UploadZone } from './upload-zone';
import { UploadBridgeContext } from './upload-bridge';
import { UploadList } from './upload-list';

function connection(): ConnectionInfo | undefined {
  return (globalThis.navigator as { connection?: ConnectionInfo } | undefined)?.connection;
}

/** Creates one engine per mounted uploader and binds it to the gallery once known. */
export function useUploadEngine({
  galleryId,
  mode,
  api,
}: {
  galleryId: string | null;
  mode: 'guest' | 'owner';
  api?: UploadApi;
}): UploadEngine {
  const [engine] = useState(() => new UploadEngine({ api: api ?? createUploadApi(), mode }));

  useEffect(() => {
    engine.activate();
    return () => engine.dispose();
  }, [engine]);

  // Follow connectivity changes (`navigator.connection`, where supported).
  useEffect(() => {
    const conn = connection();
    if (!conn?.addEventListener) return;
    const update = () => engine.setMaxConcurrency(baseConcurrency(detectMobile(), conn));
    update();
    conn.addEventListener('change', update);
    return () => conn.removeEventListener?.('change', update);
  }, [engine]);

  useEffect(() => {
    if (!galleryId) return;
    let cancelled = false;
    engine.setGallery(galleryId);
    void (async () => {
      const store = await openDraftStore().catch(() => null);
      if (cancelled) {
        store?.close();
        return;
      }
      engine.setStore(store);
      await engine.restore();
      if (mode === 'guest' && !cancelled) {
        try {
          const draft = await (api ?? createUploadApi()).getGuestDraft();
          if (cancelled || draft.gallery.id !== galleryId) return;
          engine.setGuestQuota(draft.quota);
          engine.hydrateFromServer(draft.media);
        } catch {
          // No draft view (e.g. claimed meanwhile): uploads still report their own errors.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, galleryId, mode, api]);

  return engine;
}

/**
 * Reusable upload area (T14): drop zone, resume prompt, sign-in prompt and per-file list. Mounted
 * by `/new` and — with `mode="owner"` — by the gallery editor (T15).
 */
export function GalleryUploader({
  galleryId,
  mode,
  signInHref,
  api,
}: {
  /** Null while the draft/gallery is still being created; files queue meanwhile. */
  galleryId: string | null;
  mode: 'guest' | 'owner';
  /** Where the "sign in to keep uploading" prompt links to. */
  signInHref: string;
  api?: UploadApi;
}) {
  const engine = useUploadEngine({ galleryId, mode, api });
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const resumeInput = useRef<HTMLInputElement>(null);
  const busy = snapshot.totals.uploading + snapshot.totals.queued > 0;

  // Leaving mid-upload loses the File handles; warn (the resume prompt covers what remains).
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  // Let the surrounding editor (if any) preview local files and pick up new photos.
  const bridge = useContext(UploadBridgeContext);
  useEffect(() => {
    if (!bridge) return;
    bridge.report(
      snapshot.items.flatMap((i) =>
        i.mediaId ? [{ mediaId: i.mediaId, state: i.state, file: engine.getFile(i.clientId) }] : [],
      ),
    );
  }, [bridge, engine, snapshot]);

  const awaiting = snapshot.items.filter((i) => i.state === 'awaiting_file');

  return (
    <div className="flex flex-col gap-6">
      {snapshot.authPrompt && (
        <div role="alert" className="lm-banner lm-banner-cap flex-col gap-3">
          <p className="font-medium">{snapshot.authPrompt.message}</p>
          <p className="text-[13px] leading-[18px]">
            Photos already uploaded stay in this draft. After signing in, choose the remaining files
            again to continue.
          </p>
          <div>
            <Link href={signInHref} className={buttonClass('primary')}>
              Sign in to keep uploading
            </Link>
          </div>
        </div>
      )}

      {awaiting.length > 0 && (
        <div className="lm-banner flex-col gap-3">
          <p className="font-medium">
            {awaiting.length === 1
              ? '1 upload was interrupted.'
              : `${awaiting.length} uploads were interrupted.`}{' '}
            Choose the same files again to resume where they stopped.
          </p>
          <input
            ref={resumeInput}
            type="file"
            multiple
            accept={PHOTO_ACCEPT}
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
            data-testid="resume-input"
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = '';
              if (files.length) void engine.resumeWith(files);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => resumeInput.current?.click()}
              className={buttonClass('primary')}
            >
              Choose files to resume
            </button>
            <button
              type="button"
              onClick={() => engine.discardAwaiting()}
              className={buttonClass('ghost')}
            >
              Discard interrupted uploads
            </button>
          </div>
        </div>
      )}

      <UploadZone onFiles={(files) => engine.addFiles(files)} />

      <UploadList
        snapshot={snapshot}
        onRetry={(id) => engine.retry(id)}
        onCancel={(id) => engine.cancel(id)}
        onRemove={(id) => engine.remove(id)}
        getFile={(id) => engine.getFile(id)}
      />
    </div>
  );
}
