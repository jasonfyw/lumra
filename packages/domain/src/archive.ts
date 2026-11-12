import { ARCHIVE_LIMITS } from '@lumra/config';
import type { ArchivePartEntry, PublicArchiveStatus } from '@lumra/contracts';
import { dedupeFilenames, sanitizeArchiveFilename, sanitizeDownloadFilename } from './filenames';
import type { TransitionTable } from './state-machine';

export const ARCHIVE_STATUSES = [
  'requested',
  'queued',
  'running',
  'ready',
  'failed',
  'expired',
  'deleted',
] as const;
export type ArchiveStatus = (typeof ARCHIVE_STATUSES)[number];

/**
 * Archive job machine (PRD §7). `deleted` is reachable from every state because the gallery
 * deletion purge (T13, `markGalleryArchivesDeleted`) removes the gallery's `archives/{galleryId}/`
 * objects and then marks all of its jobs `deleted`, including ones still building; the builder's
 * conditional updates (`status = 'running'`) then no-op, so a deleted job never turns ready.
 */
export const ARCHIVE_TRANSITIONS: TransitionTable<ArchiveStatus> = {
  requested: ['queued', 'failed', 'deleted'],
  queued: ['running', 'failed', 'deleted'],
  running: ['ready', 'failed', 'deleted'],
  ready: ['expired', 'deleted'],
  failed: ['queued', 'deleted'],
  expired: ['deleted'],
  deleted: [],
};

// ---------------------------------------------------------------------------------------------
// Partitioning and naming (FR-D02/D03, T24, ADR-003)
// ---------------------------------------------------------------------------------------------

/** A ready original to put in an archive, in display order. */
export interface ArchiveSourceItem {
  mediaId: string;
  /** User-supplied upload filename (sanitized here, never trusted). */
  filename: string;
  mime: string;
  bytes: number;
}

export interface ArchivePartPlan {
  partNo: number;
  entries: ArchivePartEntry[];
  itemCount: number;
  sourceBytes: number;
}

export interface ArchivePlan {
  parts: ArchivePartPlan[];
  itemCount: number;
  totalBytes: number;
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/**
 * Splits the items into ZIP parts of at most `maxItemsPerPart` items and `maxBytesPerPart`
 * original bytes (FR-D03), keeping display order. Entry names are sanitized and de-duplicated
 * across the *whole* archive, so extracting every part into one folder never overwrites a file.
 * A single item larger than the byte bound gets a part of its own (originals are capped far
 * below it). Deterministic: the same input always yields the same plan.
 */
export function planArchive(
  items: readonly ArchiveSourceItem[],
  limits: { maxItemsPerPart: number; maxBytesPerPart: number } = ARCHIVE_LIMITS,
): ArchivePlan {
  if (limits.maxItemsPerPart < 1 || limits.maxBytesPerPart < 1) {
    throw new RangeError('archive part limits must be positive');
  }
  const names = dedupeFilenames(
    items.map((item) => sanitizeArchiveFilename(item.filename, MIME_EXTENSIONS[item.mime])),
  );
  const parts: ArchivePartPlan[] = [];
  let current: ArchivePartPlan | null = null;
  let totalBytes = 0;
  items.forEach((item, i) => {
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0) {
      throw new RangeError('archive item bytes must be a non-negative safe integer');
    }
    if (
      !current ||
      current.itemCount + 1 > limits.maxItemsPerPart ||
      (current.itemCount > 0 && current.sourceBytes + item.bytes > limits.maxBytesPerPart)
    ) {
      current = { partNo: parts.length + 1, entries: [], itemCount: 0, sourceBytes: 0 };
      parts.push(current);
    }
    current.entries.push({ mediaId: item.mediaId, name: names[i]!, bytes: item.bytes });
    current.itemCount += 1;
    current.sourceBytes += item.bytes;
    totalBytes += item.bytes;
  });
  return { parts, itemCount: items.length, totalBytes };
}

/**
 * Identity of an archive's content: SHA-256 (hex) over the ordered `mediaId/name` list. Two
 * requests with equal fingerprints (and content/access versions) can share one job.
 */
export async function archiveSourceFingerprint(plan: ArchivePlan): Promise<string> {
  const canonical = plan.parts
    .flatMap((part) => part.entries.map((e) => `${e.mediaId}/${e.name}`))
    .join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `Content-Disposition` name of one part: `{gallery title}.zip`, or
 * `{gallery title} (part 2 of 4).zip` when the archive is split. The gateway sanitizes again.
 */
export function archivePartDownloadName(title: string, partNo: number, partCount: number): string {
  const base = sanitizeDownloadFilename(title.trim().slice(0, 120), 'Lumra photos').replace(
    /\.zip$/i,
    '',
  );
  const suffix = partCount > 1 ? ` (part ${partNo} of ${partCount})` : '';
  return `${base}${suffix}.zip`;
}

/** Recipient-facing status (PRD §7 machine collapsed; see `PUBLIC_ARCHIVE_STATUSES`). */
export function toPublicArchiveStatus(status: ArchiveStatus): PublicArchiveStatus {
  switch (status) {
    case 'requested':
    case 'queued':
      return 'preparing';
    case 'running':
      return 'processing';
    case 'ready':
      return 'ready';
    case 'failed':
      return 'failed';
    case 'expired':
    case 'deleted':
      return 'expired';
  }
}

/** Whole-percent progress, never 100 until the job is actually ready. */
export function archiveProgressPct(doneBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  const pct = Math.floor((Math.max(0, doneBytes) * 100) / totalBytes);
  return Math.min(99, Math.max(0, pct));
}
