import exifReader from 'exif-reader';

const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;
/** Earliest plausible capture time; anything before is treated as a bogus camera clock. */
const MIN_TAKEN_AT = Date.UTC(1900, 0, 1);
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

function offsetMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = OFFSET.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  if (minutes > 14 * 60) return null;
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * Capture time from the EXIF block sharp exposes as `metadata().exif` (FR-M07).
 *
 * `DateTimeOriginal` has no zone; exif-reader parses it as UTC wall-clock. With
 * `OffsetTimeOriginal` we convert it to a real instant; without it the wall-clock value is
 * stored as if it were UTC (documented approximation — the gallery only sorts/display dates).
 * Returns an ISO string or null; never throws on malformed EXIF.
 */
export function extractTakenAt(exif: Buffer | undefined, now: number = Date.now()): string | null {
  if (!exif || exif.length === 0) return null;
  let parsed: ReturnType<typeof exifReader>;
  try {
    parsed = exifReader(exif);
  } catch {
    return null;
  }
  const photo = (parsed.Photo ?? {}) as Record<string, unknown>;
  const raw = photo.DateTimeOriginal ?? photo.DateTimeDigitized;
  if (!(raw instanceof Date) || Number.isNaN(raw.getTime())) return null;
  const offset = offsetMinutes(photo.OffsetTimeOriginal ?? photo.OffsetTime);
  const instant = raw.getTime() - (offset ?? 0) * 60_000;
  if (instant < MIN_TAKEN_AT || instant > now + MAX_CLOCK_SKEW_MS) return null;
  return new Date(instant).toISOString();
}
