/**
 * Download filename sanitising (FR-D01/FR-D02). Shared by the media gateway's
 * `Content-Disposition` and the archive builder (T24), which adds collision suffixes on top.
 *
 * Removes control chars, bidi overrides (extension spoofing) and characters unsafe on common
 * filesystems.
 */
const UNSAFE_FILENAME_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069"*:<>?|\\/]/g;
const MAX_FILENAME_CODEPOINTS = 150;

/**
 * Reduces a user-supplied filename to a safe download name: last path segment only, no control
 * or reserved characters, no leading dots, bounded length. Falls back when nothing remains.
 */
export function sanitizeDownloadFilename(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const lastSegment = raw.normalize('NFC').split(/[\\/]/).pop() ?? '';
  let name = lastSegment.replace(UNSAFE_FILENAME_CHARS, '').replace(/\s+/g, ' ');
  name = name.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  name = Array.from(name).slice(0, MAX_FILENAME_CODEPOINTS).join('');
  return name || fallback;
}
