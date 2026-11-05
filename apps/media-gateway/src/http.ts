/** HTTP helpers for the media gateway: ranges, validators, filenames, CORS. Pure functions. */

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * Parses a `Range` header against a known size (RFC 9110 §14). Returns:
 * - `null` when the header is absent, malformed, multi-range or not `bytes` — serve 200;
 * - `'unsatisfiable'` — respond 416;
 * - a single satisfiable range otherwise.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const [, startText = '', endText = ''] = match;
  if (startText === '' && endText === '') return null;
  const startNum = startText === '' ? null : Number(startText);
  const endNum = endText === '' ? null : Number(endText);
  if (
    (startNum !== null && !Number.isSafeInteger(startNum)) ||
    (endNum !== null && !Number.isSafeInteger(endNum))
  ) {
    return null;
  }

  if (startNum === null) {
    // Suffix range: last N bytes.
    const suffix = endNum as number;
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  if (endNum !== null && endNum < startNum) return null;
  if (startNum >= size) return 'unsatisfiable';
  return { start: startNum, end: Math.min(endNum ?? size - 1, size - 1) };
}

const stripWeak = (tag: string) => tag.trim().replace(/^W\//, '');

/** Weak comparison of `If-None-Match` against the object's quoted ETag. */
export function ifNoneMatchHits(header: string | null, httpEtag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const target = stripWeak(httpEtag);
  return header.split(',').some((tag) => stripWeak(tag) === target);
}

/** `If-Range` permits the range only for a strong ETag match; dates are treated as mismatch. */
export function ifRangeAllows(header: string | null, httpEtag: string): boolean {
  if (!header) return true;
  const value = header.trim();
  return !value.startsWith('W/') && value === httpEtag;
}

/** RFC 6266 / RFC 8187 `Content-Disposition` with an ASCII fallback and a UTF-8 `filename*`. */
export function contentDisposition(type: 'attachment' | 'inline', filename?: string): string {
  if (!filename) return type;
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export const CORS_EXPOSED_HEADERS =
  'Accept-Ranges, Content-Disposition, Content-Length, Content-Range, ETag';

/** CORS headers for an allowed origin (exact match only; never `*`). */
export function corsHeaders(origin: string | null, allowed: readonly string[]): Headers {
  const headers = new Headers({ Vary: 'Origin' });
  if (origin && allowed.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS);
  }
  return headers;
}
