/**
 * Safe filenames for ZIP archive entries (FR-D02, PRD §11 "Archive contains `../` filename").
 *
 * The result is always a single path component: no separators, no `.`/`..`, no control or
 * Windows-reserved characters/names, bounded length, extension preserved where possible.
 * Extracting an archive built from these names cannot escape the target directory.
 */

const MAX_FILENAME_LENGTH = 180; // UTF-16 code units; well under the 255-byte limit of most FSs
const MAX_EXTENSION_LENGTH = 10;
const FALLBACK_BASENAME = 'photo';

// Windows reserved device names (with or without an extension), case-insensitive.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// Path separators, Windows-forbidden characters, C0/C1 controls, and bidi/zero-width overrides
// that can disguise an extension (e.g. "gpj.exe" shown as "exe.jpg").
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, max);
  // Don't split a surrogate pair.
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' };
  const ext = name.slice(dot + 1);
  if (ext.length > MAX_EXTENSION_LENGTH || !/^[\p{L}\p{N}]+$/u.test(ext)) {
    return { base: name, ext: '' };
  }
  return { base: name.slice(0, dot), ext };
}

/**
 * Sanitize a user-supplied filename into one safe archive entry name.
 * `fallbackExtension` (e.g. from the sniffed MIME) is used when the name has no usable extension.
 */
export function sanitizeArchiveFilename(name: string, fallbackExtension?: string): string {
  // Keep only the last path component, whichever separator the client used.
  const lastComponent = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = lastComponent
    .normalize('NFC')
    .replace(UNSAFE_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows strips trailing dots/spaces; leading dots create hidden files or `..`.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');

  let { base, ext } = splitExtension(cleaned);
  base = base.replace(/[.\s]+$/, '');
  if (!base || /^_+$/.test(base)) base = FALLBACK_BASENAME;
  // `CON.jpg` is as reserved as `CON`; also catch `con.tar.gz`-style first segments.
  const firstSegment = base.split('.')[0] ?? base;
  if (WINDOWS_RESERVED.test(firstSegment.trim())) base = `_${base}`;
  if (!ext && fallbackExtension && /^[a-z0-9]{1,10}$/i.test(fallbackExtension)) {
    ext = fallbackExtension.toLowerCase();
  }

  const suffix = ext ? `.${ext}` : '';
  const truncated = truncate(base, MAX_FILENAME_LENGTH - suffix.length).replace(/[.\s]+$/, '');
  return (truncated || FALLBACK_BASENAME) + suffix;
}

/**
 * Deterministic collision suffixes for archive entries, in input order:
 * `a.jpg, a.jpg, A.JPG` → `a.jpg, a (2).jpg, A (3).JPG`. Comparison is case-insensitive
 * (Windows/macOS file systems), and generated names never collide with later originals.
 * Callers should pass already-sanitized names in a stable order (e.g. gallery position).
 */
export function dedupeFilenames(names: readonly string[]): string[] {
  const keyOf = (n: string) => n.normalize('NFC').toLowerCase();
  const taken = new Set<string>();
  const reserved = new Set(names.map(keyOf));
  const result: string[] = [];
  for (const name of names) {
    if (!taken.has(keyOf(name))) {
      taken.add(keyOf(name));
      result.push(name);
      continue;
    }
    const dot = name.lastIndexOf('.');
    const hasExt = dot > 0;
    const base = hasExt ? name.slice(0, dot) : name;
    const ext = hasExt ? name.slice(dot) : '';
    for (let n = 2; ; n++) {
      const suffix = ` (${n})`;
      const candidate =
        truncate(base, MAX_FILENAME_LENGTH - suffix.length - ext.length) + suffix + ext;
      const key = keyOf(candidate);
      // Skip names already used, and names that appear verbatim later in the input.
      if (taken.has(key) || reserved.has(key)) continue;
      taken.add(key);
      result.push(candidate);
      break;
    }
  }
  return result;
}
