import { IMAGE_VALIDATION, UPLOAD_LIMITS } from '@lumra/config';
import { describe, expect, it } from 'vitest';
import { isAcceptedExtension, precheckFile, sniffImage } from './sniff';

// ---- Programmatic fixture corpus: minimal valid headers, no binary files in git. ----

const bytes = (...parts: (number[] | Uint8Array | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const c of p) out.push(c.charCodeAt(0));
    else out.push(...p);
  }
  return Uint8Array.from(out);
};
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [...u32be(n)].reverse();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function jpeg(opts: {
  width: number;
  height: number;
  orientation?: number;
  littleEndian?: boolean;
  sof?: number;
}): Uint8Array {
  const segments: Uint8Array[] = [];
  const segment = (marker: number, payload: Uint8Array) =>
    segments.push(bytes([0xff, marker], u16be(payload.length + 2), payload));
  segment(0xe0, bytes('JFIF\0', [1, 1, 0], u16be(72), u16be(72), [0, 0]));
  if (opts.orientation !== undefined) {
    const le = opts.littleEndian ?? false;
    const w16 = le ? u16le : u16be;
    const w32 = le ? u32le : u32be;
    const tiff = bytes(
      le ? 'II' : 'MM',
      w16(42),
      w32(8),
      w16(2), // two IFD0 entries
      w16(0x010f), // Make (ignored)
      w16(2),
      w32(4),
      bytes('ACME'),
      w16(0x0112), // Orientation, SHORT, count 1
      w16(3),
      w32(1),
      w16(opts.orientation),
      [0, 0],
      w32(0),
    );
    segment(0xe1, bytes('Exif\0\0', tiff));
  }
  segment(0xdb, new Uint8Array(65)); // DQT
  segment(
    opts.sof ?? 0xc0,
    bytes([8], u16be(opts.height), u16be(opts.width), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  );
  segment(0xc4, new Uint8Array(20)); // DHT
  return bytes(
    [0xff, 0xd8],
    ...segments,
    [0xff, 0xda],
    u16be(12),
    new Uint8Array(10),
    [0xff, 0xd9],
  );
}

function png(width: number, height: number, colorType = 6, bitDepth = 8): Uint8Array {
  const ihdr = bytes('IHDR', u32be(width), u32be(height), [bitDepth, colorType, 0, 0, 0]);
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    u32be(13),
    ihdr,
    u32be(crc32(ihdr)),
    u32be(0),
    'IEND',
    u32be(crc32(bytes('IEND'))),
  );
}

function riff(chunk: string, data: Uint8Array): Uint8Array {
  return bytes('RIFF', u32le(4 + 8 + data.length), 'WEBP', chunk, u32le(data.length), data);
}
const webpVp8 = (w: number, h: number) =>
  riff('VP8 ', bytes([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a], u16le(w), u16le(h), new Uint8Array(8)));
const webpVp8l = (w: number, h: number) =>
  riff('VP8L', bytes([0x2f], u32le(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)), [0, 0, 0]));
const webpVp8x = (w: number, h: number) =>
  riff('VP8X', bytes([0x10, 0, 0, 0], u24le(w - 1), u24le(h - 1)));

const box = (type: string, ...payload: Uint8Array[]) => {
  const body = bytes(...payload);
  return bytes(u32be(8 + body.length), type, body);
};
const fullBox = (type: string, version: number, flags: number, ...payload: Uint8Array[]) =>
  box(
    type,
    bytes([version], [(flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]),
    ...payload,
  );
const ftyp = (major: string, ...compatible: string[]) =>
  box('ftyp', bytes(major, u32be(0), ...compatible));

/** HEIC with a 512×512 thumbnail ispe (item 2) and a 4032×3024 primary ispe (item 1). */
function heic(major = 'heic', compatible = ['mif1', 'heic'], primary = { w: 4032, h: 3024 }) {
  const ispe = (w: number, h: number) => fullBox('ispe', 0, 0, bytes(u32be(w), u32be(h)));
  const meta = fullBox(
    'meta',
    0,
    0,
    fullBox('hdlr', 0, 0, bytes(u32be(0), 'pict', new Uint8Array(13))),
    fullBox('pitm', 0, 0, bytes(u16be(1))),
    box(
      'iprp',
      box('ipco', ispe(512, 512), ispe(primary.w, primary.h)),
      fullBox(
        'ipma',
        0,
        0,
        bytes(u32be(2), u16be(2), [1, 0x81], u16be(1), [1, 0x82]), // item2→prop1, item1→prop2
      ),
    ),
  );
  return bytes(ftyp(major, ...compatible), meta, box('mdat', new Uint8Array(16)));
}

// ---------------------------------------------------------------- tests

describe('sniffImage — accepted formats', () => {
  it('reads JPEG dimensions from SOF0 and SOF2', () => {
    expect(sniffImage(jpeg({ width: 6000, height: 4000 }))).toEqual({
      ok: true,
      mime: 'image/jpeg',
      width: 6000,
      height: 4000,
    });
    expect(sniffImage(jpeg({ width: 800, height: 600, sof: 0xc2 }))).toMatchObject({
      ok: true,
      width: 800,
      height: 600,
    });
  });

  it('reads EXIF orientation in both byte orders', () => {
    expect(sniffImage(jpeg({ width: 10, height: 20, orientation: 6 }))).toMatchObject({
      ok: true,
      orientation: 6,
    });
    expect(
      sniffImage(jpeg({ width: 10, height: 20, orientation: 8, littleEndian: true })),
    ).toMatchObject({ ok: true, orientation: 8 });
    expect(sniffImage(jpeg({ width: 10, height: 20, orientation: 42 }))).not.toHaveProperty(
      'orientation',
    );
  });

  it('reads PNG IHDR', () => {
    expect(sniffImage(png(1920, 1080))).toEqual({
      ok: true,
      mime: 'image/png',
      width: 1920,
      height: 1080,
    });
  });

  it('reads WebP VP8, VP8L and VP8X', () => {
    expect(sniffImage(webpVp8(1024, 768))).toEqual({
      ok: true,
      mime: 'image/webp',
      width: 1024,
      height: 768,
    });
    expect(sniffImage(webpVp8l(300, 200))).toMatchObject({ ok: true, width: 300, height: 200 });
    expect(sniffImage(webpVp8x(5000, 3000))).toMatchObject({ ok: true, width: 5000, height: 3000 });
  });

  it('reads HEIC primary-item dimensions via pitm/ipma/ispe', () => {
    expect(sniffImage(heic())).toEqual({
      ok: true,
      mime: 'image/heic',
      width: 4032,
      height: 3024,
    });
  });

  it('accepts the generic HEIF brands and leaves dimensions null when meta is out of reach', () => {
    expect(sniffImage(heic('mif1', ['mif1', 'heic']))).toMatchObject({ ok: true, width: 4032 });
    expect(sniffImage(heic('msf1', ['msf1', 'mif1']))).toMatchObject({ ok: true });
    const full = heic();
    const headerOnly = full.subarray(0, 40); // ftyp + start of meta
    expect(sniffImage(headerOnly)).toEqual({
      ok: true,
      mime: 'image/heic',
      width: null,
      height: null,
    });
  });
});

describe('sniffImage — rejection corpus (T11 AC)', () => {
  it('rejects a Windows executable renamed to .jpg', () => {
    const exe = bytes('MZ', [0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff], new Uint8Array(48));
    expect(sniffImage(exe)).toEqual({ ok: false, code: 'unsupported_type' });
    expect(precheckFile({ name: 'holiday.jpg', size: exe.length }, exe)).toEqual({
      ok: false,
      code: 'unsupported_type',
    });
  });

  it('rejects other non-photo content', () => {
    for (const other of [
      bytes('GIF89a', new Uint8Array(10)),
      bytes('%PDF-1.7', new Uint8Array(10)),
      bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      bytes([0x49, 0x49, 0x2a, 0x00], new Uint8Array(12)), // TIFF / many RAW formats
      bytes(u32be(24), ftyp('mp42', 'isom', 'mp42').subarray(4), new Uint8Array(8)), // MP4 video
    ]) {
      expect(sniffImage(other)).toEqual({ ok: false, code: 'unsupported_type' });
    }
  });

  it('rejects truncated JPEGs', () => {
    const full = jpeg({ width: 100, height: 100, orientation: 1 });
    for (const cut of [2, 3, 10, 30, 60]) {
      expect(sniffImage(full.subarray(0, cut))).toEqual({ ok: false, code: 'truncated' });
    }
    expect(sniffImage(new Uint8Array())).toEqual({ ok: false, code: 'truncated' });
    expect(sniffImage(png(10, 10).subarray(0, 20))).toEqual({ ok: false, code: 'truncated' });
  });

  it('rejects a 50000×50000 PNG decompression bomb', () => {
    expect(sniffImage(png(50_000, 50_000))).toEqual({ ok: false, code: 'too_many_pixels' });
    expect(sniffImage(jpeg({ width: 65_000, height: 65_000 }))).toEqual({
      ok: false,
      code: 'too_many_pixels',
    });
    expect(sniffImage(webpVp8x(16_000, 16_000))).toEqual({ ok: false, code: 'too_many_pixels' });
    expect(sniffImage(heic('heic', ['mif1'], { w: 20_000, h: 20_000 }))).toEqual({
      ok: false,
      code: 'too_many_pixels',
    });
  });

  it('accepts images exactly at the pixel limit', () => {
    const side = Math.floor(Math.sqrt(IMAGE_VALIDATION.maxPixels));
    expect(sniffImage(png(side, side))).toMatchObject({ ok: true });
  });

  it('classifies HEIF variants', () => {
    expect(sniffImage(heic('heiz', ['heiz']))).toEqual({
      ok: false,
      code: 'heic_unsupported_variant',
    });
    expect(sniffImage(heic('mif1', ['mif1', 'heim']))).toEqual({
      ok: false,
      code: 'heic_unsupported_variant',
    });
    expect(sniffImage(heic('avif', ['mif1', 'avif']))).toEqual({
      ok: false,
      code: 'unsupported_type',
    });
    expect(sniffImage(heic('heix', ['mif1', 'heix']))).toMatchObject({ ok: true });
  });

  it('rejects malformed headers', () => {
    const badCrc = png(10, 10);
    badCrc[29] = badCrc[29]! ^ 0xff;
    expect(sniffImage(badCrc)).toEqual({ ok: false, code: 'malformed' });
    expect(sniffImage(png(10, 10, 2, 4))).toEqual({ ok: false, code: 'malformed' }); // bad depth
    expect(sniffImage(png(0, 10))).toEqual({ ok: false, code: 'malformed' });
    expect(sniffImage(jpeg({ width: 0, height: 10 }))).toEqual({ ok: false, code: 'malformed' });
    // SOS before any SOF.
    expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xda], u16be(8), new Uint8Array(6)))).toEqual({
      ok: false,
      code: 'malformed',
    });
    expect(sniffImage(riff('ABCD', new Uint8Array(10)))).toEqual({ ok: false, code: 'malformed' });
  });

  it('never throws on random input', () => {
    let seed = 1;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    const prefixes = [jpeg({ width: 1, height: 1 }), png(1, 1), webpVp8(1, 1), heic()];
    for (let i = 0; i < 400; i++) {
      const base = prefixes[i % prefixes.length]!;
      const fuzzed = Uint8Array.from(base, (b, j) => (j > 3 && rand() < 16 ? rand() : b));
      expect(() => sniffImage(fuzzed.subarray(0, (rand() << 2) % (base.length + 1)))).not.toThrow();
    }
  });
});

describe('isAcceptedExtension', () => {
  it('accepts FR-M01 extensions case-insensitively', () => {
    for (const name of [
      'a.jpg',
      'B.JPEG',
      'c.png',
      'd.WebP',
      'IMG_0001.HEIC',
      'x.heif',
      'a.b.jpg',
    ]) {
      expect(isAcceptedExtension(name)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const name of [
      '',
      'jpg',
      'a.',
      'a.gif',
      'a.mp4',
      'a.cr2',
      'a.jpg.exe',
      'a.dng',
      'a.mov',
    ]) {
      expect(isAcceptedExtension(name)).toBe(false);
    }
  });
});

describe('precheckFile', () => {
  const head = jpeg({ width: 4000, height: 3000, orientation: 3 });

  it('passes a valid photo and reports metadata', () => {
    expect(precheckFile({ name: 'IMG_1.jpg', size: 3_000_000, type: 'image/jpeg' }, head)).toEqual({
      ok: true,
      mime: 'image/jpeg',
      width: 4000,
      height: 3000,
      orientation: 3,
    });
  });

  it('trusts content over the name and browser type', () => {
    expect(
      precheckFile({ name: 'misnamed.png', size: 1000, type: 'image/png' }, head),
    ).toMatchObject({ ok: true, mime: 'image/jpeg' });
  });

  it('rejects by extension, size and content in that order', () => {
    expect(precheckFile({ name: 'clip.mov', size: 10 }, head)).toEqual({
      ok: false,
      code: 'unsupported_extension',
    });
    expect(precheckFile({ name: 'a.jpg', size: 0 }, head)).toEqual({
      ok: false,
      code: 'empty_file',
    });
    expect(precheckFile({ name: 'a.jpg', size: UPLOAD_LIMITS.maxPhotoBytes + 1 }, head)).toEqual({
      ok: false,
      code: 'file_too_large',
    });
    expect(precheckFile({ name: 'a.jpg', size: UPLOAD_LIMITS.maxPhotoBytes }, head)).toMatchObject({
      ok: true,
    });
  });
});
