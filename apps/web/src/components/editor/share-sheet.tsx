'use client';

import { create as createQr } from 'qrcode';
import { useMemo, useRef, useState } from 'react';

/** Module matrix for `text` (pure; no canvas needed, so it renders in SSR and tests too). */
export function qrMatrix(text: string): boolean[][] {
  const { modules } = createQr(text, { errorCorrectionLevel: 'M' });
  return Array.from({ length: modules.size }, (_, row) =>
    Array.from({ length: modules.size }, (_, col) => Boolean(modules.get(row, col))),
  );
}

const QUIET_ZONE = 4; // modules of white border required by the QR spec

/** Draws the matrix onto a canvas and returns a PNG blob (browser only). */
async function qrPng(matrix: boolean[][], scale = 12): Promise<Blob | null> {
  const size = (matrix.length + QUIET_ZONE * 2) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  matrix.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) ctx.fillRect((x + QUIET_ZONE) * scale, (y + QUIET_ZONE) * scale, scale, scale);
    }),
  );
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

const button =
  'inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-line)] px-4 font-medium';
const primary =
  'inline-flex min-h-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-accent)] px-5 font-medium text-white';

/**
 * Share sheet (T21, PRD §4 "Sharing UI"): Copy link is primary; a QR code (downloadable PNG);
 * the Web Share API when the browser has it, falling back to copying. No email invites in v1.
 */
export function ShareSheet({ url, title }: { url: string; title: string }) {
  const [status, setStatus] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const matrix = useMemo(() => qrMatrix(url), [url]);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setStatus('Link copied.');
      return;
    } catch {
      // Clipboard API missing or denied (e.g. insecure context): select the text instead.
    }
    const input = inputRef.current;
    input?.focus();
    input?.select();
    let copied: boolean;
    try {
      copied = document.execCommand?.('copy') ?? false;
    } catch {
      copied = false;
    }
    setStatus(copied ? 'Link copied.' : 'Link selected — press Ctrl+C or ⌘C to copy.');
  }

  async function share() {
    try {
      await navigator.share({ title, url });
      setStatus('');
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return; // user closed the sheet
      await copy();
    }
  }

  async function downloadQr() {
    const blob = await qrPng(matrix);
    if (!blob) {
      setStatus('Could not create the QR image in this browser.');
      return;
    }
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = 'lumra-gallery-qr.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    setStatus('QR code downloaded.');
  }

  const n = matrix.length + QUIET_ZONE * 2;
  const path = matrix
    .flatMap((row, y) =>
      row.map((on, x) => (on ? `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z` : '')),
    )
    .join('');

  return (
    <section aria-labelledby="share-heading" className="flex flex-col gap-4">
      <h2 id="share-heading" className="text-lg font-semibold">
        Share
      </h2>
      <label className="flex flex-col gap-1 text-sm text-[var(--color-ink-muted)]">
        Share link
        <input
          ref={inputRef}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-h-11 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface)] px-3 text-base text-[var(--color-ink)]"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={copy} className={primary}>
          Copy link
        </button>
        {canShare && (
          <button type="button" onClick={share} className={button}>
            Share…
          </button>
        )}
        <button type="button" onClick={downloadQr} className={button}>
          Download QR code
        </button>
      </div>
      <svg
        role="img"
        aria-label={`QR code for ${url}`}
        data-qr-url={url}
        viewBox={`0 0 ${n} ${n}`}
        shapeRendering="crispEdges"
        className="h-40 w-40 rounded border border-[var(--color-line)]"
      >
        <rect width={n} height={n} fill="#fff" />
        <path d={path} fill="#000" />
      </svg>
      <p aria-live="polite" role="status" className="min-h-5 text-sm text-[var(--color-ink-muted)]">
        {status}
      </p>
    </section>
  );
}
