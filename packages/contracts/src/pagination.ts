import { z } from 'zod';

/**
 * Opaque keyset cursor for lists sorted by `(updated_at DESC, id DESC)` (PRD §10, FR-N01).
 * `ts` keeps Postgres' full microsecond precision as an ISO-8601 UTC string: a JS `Date` would
 * round to milliseconds and skip or repeat rows that share a millisecond.
 * Encoding: base64url(JSON `[ts, id]`). Web APIs only, so it also runs in Workers.
 */
export interface KeysetCursor {
  ts: string;
  id: string;
}

const cursorTupleSchema = z.tuple([z.iso.datetime(), z.uuid()]);

const MAX_CURSOR_LENGTH = 256;

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return toBase64Url(JSON.stringify([cursor.ts, cursor.id]));
}

/** Returns null for anything malformed; callers answer 422 rather than guessing. */
export function decodeKeysetCursor(value: string): KeysetCursor | null {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed = cursorTupleSchema.safeParse(JSON.parse(fromBase64Url(value)));
    return parsed.success ? { ts: parsed.data[0], id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}
