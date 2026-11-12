'use client';

import { ARCHIVE_LIMITS, PUBLIC_GALLERY } from '@lumra/config';
import {
  archiveStatusResponseSchema,
  createArchiveResponseSchema,
  type ArchiveFailureCode,
  type ArchiveStatusResponse,
} from '@lumra/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, Tag, Wordmark, buttonClass } from '@/components/ui';
import { formatBytes } from '@/lib/format';

export interface ArchiveProgressProps {
  initial: ArchiveStatusResponse;
  /** false: render the given state only (dev fixtures, tests); no polling or retries. */
  live?: boolean;
}

const photos = (n: number) => (n === 1 ? '1 photo' : `${n.toLocaleString('en-US')} photos`);

const FAILURE_COPY: Record<ArchiveFailureCode, string> = {
  content_changed:
    'The gallery changed while we were preparing it. Start again to get the latest photos.',
  gallery_unavailable: 'This gallery is no longer available.',
  original_missing: 'One of the photos could not be read. Trying again usually works.',
  build_failed: 'Nothing was lost. Trying again usually works.',
  stalled: 'This took longer than expected. Trying again usually works.',
};

function expiryText(iso: string | null): string {
  if (!iso) return 'Links expire 24 hours after the download is ready.';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'These links have expired.';
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `Available for about ${hours} more ${hours === 1 ? 'hour' : 'hours'}.`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `Available for about ${minutes} more ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/**
 * Recipient archive progress (`/archive/[jobId]`, PRD §4, T25). Polls the status API every
 * `ARCHIVE_LIMITS.pollIntervalMs` while the archive is being prepared (paused in hidden tabs),
 * and once ready re-polls shortly before the part URLs expire so links are always fresh.
 * Failed and expired archives offer to start a new one (a new job for the gallery's current
 * content). Status changes are announced politely; motion is limited to the progress bar, which
 * stops animating under `prefers-reduced-motion`.
 */
export function ArchiveProgress({ initial, live = true }: ArchiveProgressProps) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [started, setStarted] = useState<Set<number>>(() => new Set());
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const api = `/api/v1/public/archives/${status.jobId}`;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(api, { cache: 'no-store' });
      if (cancelled.current) return;
      if (res.status === 401 || res.status === 404 || res.status === 410) {
        router.refresh();
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as { data: unknown };
      const parsed = archiveStatusResponseSchema.safeParse(body.data);
      if (parsed.success && !cancelled.current) setStatus(parsed.data);
    } catch {
      // Network blip: try again on the next tick.
    }
  }, [api, router]);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const building = status.status === 'preparing' || status.status === 'processing';
  useEffect(() => {
    if (!live || !building) return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, ARCHIVE_LIMITS.pollIntervalMs);
    return () => clearInterval(id);
  }, [live, building, refresh]);

  // Ready: refresh the short-lived part URLs before they expire.
  useEffect(() => {
    if (!live || status.status !== 'ready') return;
    const expires = status.urlsExpireAt ? Date.parse(status.urlsExpireAt) : Date.now();
    const wait = Math.max(5_000, expires - Date.now() - PUBLIC_GALLERY.urlRefreshLeadMs);
    const id = setTimeout(() => void refresh(), wait);
    return () => clearTimeout(id);
  }, [live, status.status, status.urlsExpireAt, refresh]);

  const startAgain = useCallback(async () => {
    if (!live) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await fetch(
        `/api/v1/public/galleries/${encodeURIComponent(status.gallery.slug)}/archives`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          cache: 'no-store',
        },
      );
      const body = (await res.json().catch(() => null)) as {
        data?: unknown;
        error?: { message?: string } | null;
      } | null;
      const parsed = createArchiveResponseSchema.safeParse(body?.data);
      if (res.ok && parsed.success) {
        router.push(`/archive/${parsed.data.jobId}`);
        return;
      }
      setRetryError(body?.error?.message ?? 'That didn’t work. Please try again in a moment.');
    } catch {
      setRetryError('You appear to be offline. Check your connection and try again.');
    } finally {
      setRetrying(false);
    }
  }, [live, router, status.gallery.slug]);

  const galleryHref = `/g/${encodeURIComponent(status.gallery.slug)}`;
  const summary = `${status.parts.length > 1 || status.itemCount !== 1 ? 'All ' : ''}${photos(
    status.itemCount,
  )} · ${formatBytes(status.totalBytes)}`;

  let body: ReactNode;
  if (building) {
    const pct = status.progressPct;
    body = (
      <>
        <div className="lm-archive-head">
          <div>
            <h2 className="lm-archive-title">Preparing your download</h2>
            <p className="lm-archive-summary">
              {summary}
              {status.partsExpected > 1 ? ` · ${status.partsExpected} parts` : ''}
            </p>
          </div>
          <span className="lm-num font-semibold" aria-hidden="true">
            {pct}%
          </span>
        </div>
        <div
          className="lm-progress lm-progress-lg"
          role="progressbar"
          aria-label="Preparing download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
        <p className="lm-archive-note">
          {status.status === 'preparing'
            ? 'Queued — this starts in a moment.'
            : 'Packing the original files.'}{' '}
          You can keep this page open or come back to it; links stay available for 24 hours once
          ready.
        </p>
      </>
    );
  } else if (status.status === 'ready') {
    const firstPending = status.parts.find((p) => !started.has(p.partNo))?.partNo;
    body = (
      <>
        <div className="lm-archive-head">
          <div>
            <h2 className="lm-archive-title">
              {status.parts.length > 1
                ? `Your download is ready in ${status.parts.length} parts`
                : 'Your download is ready'}
            </h2>
            <p className="lm-archive-summary">{summary}</p>
          </div>
          <Tag tone="ready" icon="check">
            Ready
          </Tag>
        </div>
        <ul className="lm-archive-parts" aria-label="Download parts">
          {status.parts.map((part) => {
            const done = started.has(part.partNo);
            const name =
              status.parts.length > 1
                ? `Part ${part.partNo} of ${status.parts.length}`
                : 'All photos';
            return (
              <li key={part.partNo} className="lm-archive-part">
                <div className="min-w-0">
                  <div className="lm-archive-part-name">{name}</div>
                  <div className="lm-archive-part-meta">
                    {photos(part.itemCount)} · {formatBytes(part.byteSize ?? part.sourceBytes)}
                  </div>
                </div>
                {done ? (
                  <Tag tone="ready" icon="check">
                    Started
                  </Tag>
                ) : (
                  <span />
                )}
                {part.downloadUrl ? (
                  <a
                    href={part.downloadUrl}
                    download={part.filename}
                    rel="noreferrer"
                    className={buttonClass(
                      part.partNo === firstPending ? 'primary' : 'secondary',
                      'sm',
                    )}
                    aria-label={`Download ${name} (${part.filename})`}
                    onClick={() => setStarted((s) => new Set(s).add(part.partNo))}
                  >
                    <Icon name="download" size={16} />
                    <span>Download</span>
                  </a>
                ) : (
                  <button type="button" className={buttonClass('secondary', 'sm')} disabled>
                    Refreshing…
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="lm-archive-note">
          Original files, exactly as uploaded. {expiryText(status.expiresAt)}
        </p>
      </>
    );
  } else if (status.status === 'failed') {
    body = (
      <div className="lm-banner lm-banner-error" role="alert">
        <Icon name="alert" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-semibold">We couldn’t finish this download</p>
          <p>{FAILURE_COPY[status.failureCode ?? 'build_failed']}</p>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="lm-archive-head">
        <div>
          <h2 className="lm-archive-title">This download has expired</h2>
          <p className="lm-archive-summary">
            Downloads are kept for 24 hours, and are replaced when the gallery changes. You can
            prepare a fresh one with the latest photos.
          </p>
        </div>
        <Tag tone="surface" icon="clock">
          Expired
        </Tag>
      </div>
    );
  }

  const canRestart = status.status === 'failed' || status.status === 'expired';
  return (
    <main className="flex min-h-dvh flex-col items-center bg-[var(--color-paper)] px-4 py-10 sm:py-16">
      <div className="flex w-full max-w-[560px] flex-col gap-6">
        <Link href="/" className="-my-1 inline-flex min-h-11 items-center self-start rounded-sm">
          <Wordmark size={24} />
        </Link>
        <div className="flex flex-col gap-1">
          <p className="lm-archive-note">Download from</p>
          <h1 className="lm-title-display-sm break-words">{status.gallery.title || 'Gallery'}</h1>
        </div>
        <section className="lm-archive" aria-live="polite" data-archive-status={status.status}>
          {body}
          {canRestart ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className={buttonClass('primary', 'md', 'self-start')}
                onClick={() => void startAgain()}
                disabled={retrying || !live}
                aria-busy={retrying}
              >
                <Icon name="refresh" size={18} />
                <span>{status.status === 'failed' ? 'Try again' : 'Prepare a new download'}</span>
              </button>
              {retryError ? (
                <p className="lm-field-error" role="alert">
                  {retryError}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
        <Link href={galleryHref} className={buttonClass('ghost', 'md', '-ml-2 self-start px-2')}>
          <Icon name="arrow-left" />
          <span>Back to the gallery</span>
        </Link>
      </div>
    </main>
  );
}
