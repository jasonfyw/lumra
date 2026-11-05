import { describe, expect, it } from 'vitest';
import { dedupeFilenames, sanitizeArchiveFilename, sanitizeDownloadFilename } from './filenames';

/** Mirrors what an unzip tool does with an entry name: resolve it under a target directory. */
function escapesTarget(entry: string): boolean {
  const parts: string[] = [];
  for (const segment of entry.split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return true;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.length !== 1 || /^[a-z]:/i.test(entry) || entry.startsWith('/');
}

describe('sanitizeArchiveFilename', () => {
  it('neutralises path traversal', () => {
    for (const evil of [
      '../../etc/passwd',
      '..\\..\\Windows\\System32\\drivers\\etc\\hosts',
      '/absolute/path.jpg',
      'C:\\Users\\me\\photo.jpg',
      '..',
      '.',
      './../x.jpg',
      'a/../../b.png',
    ]) {
      const safe = sanitizeArchiveFilename(evil);
      expect(safe).not.toMatch(/[\\/]/);
      expect(safe).not.toBe('..');
      expect(safe.startsWith('.')).toBe(false);
      expect(escapesTarget(safe)).toBe(false);
    }
    expect(sanitizeArchiveFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeArchiveFilename('C:\\Users\\me\\photo.jpg')).toBe('photo.jpg');
  });

  it('strips control, bidi-override and Windows-forbidden characters', () => {
    expect(sanitizeArchiveFilename('a\u0000b\nc.jpg')).toBe('a_b_c.jpg');
    expect(sanitizeArchiveFilename('my:photo*?.jpg')).toBe('my_photo__.jpg');
    // "IMG_\u202Egpj.exe" renders as "IMG_exe.jpg" in some UIs.
    expect(sanitizeArchiveFilename('IMG_\u202egpj.exe')).toBe('IMG__gpj.exe');
  });

  it('escapes Windows reserved device names', () => {
    expect(sanitizeArchiveFilename('CON')).toBe('_CON');
    expect(sanitizeArchiveFilename('con.jpg')).toBe('_con.jpg');
    expect(sanitizeArchiveFilename('LPT1.png')).toBe('_LPT1.png');
    expect(sanitizeArchiveFilename('console.jpg')).toBe('console.jpg');
  });

  it('removes leading dots and trailing dots/spaces', () => {
    expect(sanitizeArchiveFilename('.hidden.jpg')).toBe('hidden.jpg');
    expect(sanitizeArchiveFilename('photo.jpg. . ')).toBe('photo.jpg');
    expect(sanitizeArchiveFilename('  spaced   name .jpg')).toBe('spaced name.jpg');
  });

  it('handles empty and all-invalid names with a fallback', () => {
    expect(sanitizeArchiveFilename('')).toBe('photo');
    expect(sanitizeArchiveFilename('   ')).toBe('photo');
    expect(sanitizeArchiveFilename('???.jpg')).toBe('photo.jpg');
    expect(sanitizeArchiveFilename('', 'heic')).toBe('photo.heic');
    expect(sanitizeArchiveFilename('scan', 'jpg')).toBe('scan.jpg');
    expect(sanitizeArchiveFilename('scan.png', 'jpg')).toBe('scan.png');
  });

  it('keeps unicode names (NFC-normalised)', () => {
    expect(sanitizeArchiveFilename('Cafe\u0301 – été 🌅.JPG')).toBe('Café – été 🌅.JPG');
    expect(sanitizeArchiveFilename('写真.heic')).toBe('写真.heic');
  });

  it('limits length while preserving the extension and surrogate pairs', () => {
    const long = sanitizeArchiveFilename(`${'a'.repeat(400)}.jpeg`);
    expect(long.length).toBeLessThanOrEqual(180);
    expect(long.endsWith('.jpeg')).toBe(true);
    const emoji = sanitizeArchiveFilename(`${'🌅'.repeat(200)}.jpg`);
    expect(emoji.endsWith('.jpg')).toBe(true);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe('dedupeFilenames', () => {
  it('adds deterministic suffixes in input order', () => {
    expect(dedupeFilenames(['a.jpg', 'b.jpg', 'a.jpg', 'a.jpg'])).toEqual([
      'a.jpg',
      'b.jpg',
      'a (2).jpg',
      'a (3).jpg',
    ]);
  });

  it('is case-insensitive', () => {
    expect(dedupeFilenames(['IMG.JPG', 'img.jpg'])).toEqual(['IMG.JPG', 'img (2).jpg']);
  });

  it('never collides with names that already exist later in the list', () => {
    const result = dedupeFilenames(['a.jpg', 'a.jpg', 'a (2).jpg']);
    expect(result).toEqual(['a.jpg', 'a (3).jpg', 'a (2).jpg']);
    expect(new Set(result.map((n) => n.toLowerCase())).size).toBe(result.length);
  });

  it('handles names without extensions and is stable across calls', () => {
    const input = ['photo', 'photo', 'photo'];
    expect(dedupeFilenames(input)).toEqual(['photo', 'photo (2)', 'photo (3)']);
    expect(dedupeFilenames(input)).toEqual(dedupeFilenames(input));
  });

  it('composes with sanitisation for hostile inputs', () => {
    const names = ['../x.jpg', 'x.jpg', '..\\x.jpg', ''].map((n) => sanitizeArchiveFilename(n));
    expect(dedupeFilenames(names)).toEqual(['x.jpg', 'x (2).jpg', 'x (3).jpg', 'photo']);
  });
});

describe('sanitizeDownloadFilename', () => {
  it('keeps the last path segment and neutralises unsafe characters', () => {
    expect(sanitizeDownloadFilename('C:\\Users\\me\\IMG 1.jpg', 'photo')).toBe('IMG 1.jpg');
    expect(sanitizeDownloadFilename('../../etc/..pa"ss\u202Egpj.exe\r\n', 'photo')).toBe(
      'pa_ss_gpj.exe',
    );
  });

  it('uses the caller fallback when nothing safe remains', () => {
    expect(sanitizeDownloadFilename('../..', 'photo')).toBe('photo');
    expect(sanitizeDownloadFilename(undefined, 'lumra-archive-part-2')).toBe(
      'lumra-archive-part-2',
    );
    expect(sanitizeDownloadFilename('""', 'lumra-archive-part-2')).toBe('lumra-archive-part-2');
  });

  it('bounds length', () => {
    expect(sanitizeDownloadFilename('é'.repeat(400), 'x').length).toBeLessThanOrEqual(180);
  });
});
