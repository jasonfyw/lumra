import {
  ACCEPTED_PHOTO_EXTENSIONS,
  IMAGE_VALIDATION,
  UPLOAD_LIMITS,
  type AcceptedPhotoMime,
} from '@lumra/config';
import type { MediaRejectionCode } from '@lumra/contracts';

/**
 * Content-based photo type detection (FR-M01, T11). Pure TypeScript over a `Uint8Array` prefix
 * of the file (`IMAGE_VALIDATION.sniffBytes`), so it runs in the browser, on Vercel and in
 * Workers. It reads container headers only; full decode errors are left to the processor.
 *
 * `width`/`height` are the stored (pre-orientation) dimensions. HEIF dimensions are `null`
 * when the `ispe` property is not reachable within the given bytes.
 */
export type SniffRejectionCode = Extract<
  MediaRejectionCode,
  'unsupported_type' | 'truncated' | 'too_many_pixels' | 'heic_unsupported_variant' | 'malformed'
>;

export interface SniffedImage {
  ok: true;
  mime: AcceptedPhotoMime;
  width: number | null;
  height: number | null;
  /** EXIF orientation 1–8 when present (JPEG APP1 only). */
  orientation?: number;
}

export interface SniffRejection {
  ok: false;
  code: SniffRejectionCode;
}

export type SniffResult = SniffedImage | SniffRejection;

const reject = (code: SniffRejectionCode): SniffRejection => ({ ok: false, code });

/** Thrown internally when a structure runs past the end of the supplied bytes. */
class Truncated extends Error {}
class Malformed extends Error {}

class Reader {
  constructor(readonly bytes: Uint8Array) {}
  get length(): number {
    return this.bytes.length;
  }
  need(offset: number, count: number): void {
    if (offset < 0 || count < 0 || offset + count > this.bytes.length) throw new Truncated();
  }
  u8(o: number): number {
    this.need(o, 1);
    return this.bytes[o]!;
  }
  u16be(o: number): number {
    this.need(o, 2);
    return (this.bytes[o]! << 8) | this.bytes[o + 1]!;
  }
  u16le(o: number): number {
    this.need(o, 2);
    return this.bytes[o]! | (this.bytes[o + 1]! << 8);
  }
  u24le(o: number): number {
    this.need(o, 3);
    return this.bytes[o]! | (this.bytes[o + 1]! << 8) | (this.bytes[o + 2]! << 16);
  }
  u32be(o: number): number {
    this.need(o, 4);
    return (
      ((this.bytes[o]! << 24) >>> 0) +
      ((this.bytes[o + 1]! << 16) | (this.bytes[o + 2]! << 8) | this.bytes[o + 3]!)
    );
  }
  u32le(o: number): number {
    this.need(o, 4);
    return (
      ((this.bytes[o + 3]! << 24) >>> 0) +
      ((this.bytes[o + 2]! << 16) | (this.bytes[o + 1]! << 8) | this.bytes[o]!)
    );
  }
  ascii(o: number, count: number): string {
    this.need(o, count);
    return String.fromCharCode(...this.bytes.subarray(o, o + count));
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b);
}

/** True if `bytes` is a (short) prefix of `signature` — i.e. could still become a match. */
function isPrefixOf(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length < signature.length && bytes.every((b, i) => signature[i] === b);
}

const FTYP = [0x66, 0x74, 0x79, 0x70];

function withPixelLimit(image: SniffedImage): SniffResult {
  if (image.width !== null && image.height !== null) {
    if (image.width < 1 || image.height < 1) return reject('malformed');
    if (image.width * image.height > IMAGE_VALIDATION.maxPixels) return reject('too_many_pixels');
  }
  return image;
}

// ---------------------------------------------------------------- JPEG

function jpegOrientation(r: Reader, start: number, end: number): number | undefined {
  // APP1 payload: "Exif\0\0" + TIFF header.
  if (end - start < 14 || r.ascii(start, 6) !== 'Exif\0\0') return undefined;
  const tiff = start + 6;
  const order = r.ascii(tiff, 2);
  if (order !== 'II' && order !== 'MM') return undefined;
  const le = order === 'II';
  const u16 = (o: number) => (le ? r.u16le(o) : r.u16be(o));
  const u32 = (o: number) => (le ? r.u32le(o) : r.u32be(o));
  if (u16(tiff + 2) !== 42) return undefined;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return undefined;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

function sniffJpeg(r: Reader): SniffResult {
  let offset = 2;
  let orientation: number | undefined;
  for (;;) {
    if (r.u8(offset) !== 0xff) throw new Malformed();
    let marker = r.u8(offset + 1);
    while (marker === 0xff) {
      offset++; // fill bytes
      marker = r.u8(offset + 1);
    }
    offset += 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone
    if (marker === 0xd9 || marker === 0xda || marker === 0xd8) throw new Malformed(); // no SOF
    const length = r.u16be(offset);
    if (length < 2) throw new Malformed();
    const payload = offset + 2;
    const end = offset + length;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 8) throw new Malformed();
      const height = r.u16be(payload + 1);
      const width = r.u16be(payload + 3);
      const image: SniffedImage = { ok: true, mime: 'image/jpeg', width, height };
      if (orientation !== undefined) image.orientation = orientation;
      return withPixelLimit(image);
    }
    if (marker === 0xe1 && orientation === undefined) {
      r.need(payload, length - 2);
      orientation = jpegOrientation(r, payload, end);
    }
    offset = end;
  }
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_BIT_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function sniffPng(r: Reader): SniffResult {
  r.need(8, 8 + 13 + 4);
  if (r.u32be(8) !== 13 || r.ascii(12, 4) !== 'IHDR') throw new Malformed();
  if (crc32(r.bytes.subarray(12, 29)) !== r.u32be(29)) throw new Malformed();
  const width = r.u32be(16);
  const height = r.u32be(20);
  if (width > 0x7fffffff || height > 0x7fffffff) throw new Malformed();
  const bitDepth = r.u8(24);
  const colorType = r.u8(25);
  if (!PNG_BIT_DEPTHS[colorType]?.includes(bitDepth)) throw new Malformed();
  return withPixelLimit({ ok: true, mime: 'image/png', width, height });
}

// ---------------------------------------------------------------- WebP

function sniffWebp(r: Reader): SniffResult {
  r.need(0, 20);
  const chunk = r.ascii(12, 4);
  const data = 20;
  if (chunk === 'VP8 ') {
    // Frame tag (3 bytes), start code 9d 01 2a, then 14-bit width/height.
    if (r.u8(data + 3) !== 0x9d || r.u8(data + 4) !== 0x01 || r.u8(data + 5) !== 0x2a) {
      throw new Malformed();
    }
    const width = r.u16le(data + 6) & 0x3fff;
    const height = r.u16le(data + 8) & 0x3fff;
    return withPixelLimit({ ok: true, mime: 'image/webp', width, height });
  }
  if (chunk === 'VP8L') {
    if (r.u8(data) !== 0x2f) throw new Malformed();
    const bits = r.u32le(data + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return withPixelLimit({ ok: true, mime: 'image/webp', width, height });
  }
  if (chunk === 'VP8X') {
    const width = r.u24le(data + 4) + 1;
    const height = r.u24le(data + 7) + 1;
    return withPixelLimit({ ok: true, mime: 'image/webp', width, height });
  }
  return reject('malformed');
}

// ---------------------------------------------------------------- HEIC / HEIF (ISO-BMFF)

/** Brands that identify a still HEVC-coded HEIF image (or the generic HEIF structure brands). */
const HEIC_BRANDS = new Set(['heic', 'heix']);
const HEIF_STRUCTURE_BRANDS = new Set(['mif1', 'msf1']);
/** HEIF family members we do not decode: layered/scalable HEVC, AVIF, JPEG-2000, VVC. */
const HEIF_UNSUPPORTED_BRANDS = new Set([
  'heim',
  'heis',
  'hevm',
  'hevs',
  'hevc',
  'hevx',
  'avif',
  'avis',
  'j2ki',
  'j2is',
  'vvic',
  'vvis',
]);
/** ISO-BMFF video/audio brands: plainly not a photo. */
const VIDEO_BRANDS = new Set([
  'isom',
  'iso2',
  'mp41',
  'mp42',
  'qt  ',
  'M4V ',
  'M4A ',
  'avc1',
  'dash',
]);

interface Box {
  type: string;
  start: number;
  payload: number;
  end: number;
}

function readBox(r: Reader, offset: number, limit: number): Box {
  let size = r.u32be(offset);
  const type = r.ascii(offset + 4, 4);
  let payload = offset + 8;
  if (size === 1) {
    const high = r.u32be(offset + 8);
    if (high !== 0) throw new Malformed(); // > 4 GiB box in a photo header
    size = r.u32be(offset + 12);
    payload = offset + 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < payload - offset || offset + size > limit) throw new Malformed();
  return { type, start: offset, payload, end: offset + size };
}

function children(r: Reader, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    const box = readBox(r, offset, to);
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

/**
 * Primary-item dimensions from `meta` → `pitm` + `iprp/ipco/ispe` + `ipma`. Returns null if any
 * required box lies beyond the supplied bytes.
 */
function heifDimensions(r: Reader, metaBox: Box): { width: number; height: number } | null {
  try {
    r.need(metaBox.start, metaBox.end - metaBox.start);
  } catch {
    return null;
  }
  const meta = children(r, metaBox.payload + 4, metaBox.end); // full box: version + flags
  const pitm = meta.find((b) => b.type === 'pitm');
  const iprp = meta.find((b) => b.type === 'iprp');
  if (!pitm || !iprp) return null;
  const primary = r.u8(pitm.payload) === 0 ? r.u16be(pitm.payload + 4) : r.u32be(pitm.payload + 4);
  const iprpChildren = children(r, iprp.payload, iprp.end);
  const ipco = iprpChildren.find((b) => b.type === 'ipco');
  if (!ipco) return null;
  const properties = children(r, ipco.payload, ipco.end);

  for (const ipma of iprpChildren.filter((b) => b.type === 'ipma')) {
    const version = r.u8(ipma.payload);
    // flags are 24-bit big-endian; bit 0 (last byte) selects 15-bit property indices.
    const wideIndex = (r.u8(ipma.payload + 3) & 1) === 1;
    let o = ipma.payload + 4;
    const entries = r.u32be(o);
    o += 4;
    for (let i = 0; i < entries; i++) {
      const itemId = version < 1 ? r.u16be(o) : r.u32be(o);
      o += version < 1 ? 2 : 4;
      const count = r.u8(o);
      o += 1;
      for (let j = 0; j < count; j++) {
        const index = wideIndex ? r.u16be(o) & 0x7fff : r.u8(o) & 0x7f;
        o += wideIndex ? 2 : 1;
        if (itemId !== primary || index === 0) continue;
        const property = properties[index - 1];
        if (property?.type === 'ispe') {
          return { width: r.u32be(property.payload + 4), height: r.u32be(property.payload + 8) };
        }
      }
    }
  }
  return null;
}

function sniffHeif(r: Reader): SniffResult {
  const ftyp = readBox(r, 0, Number.MAX_SAFE_INTEGER);
  if (ftyp.end - ftyp.payload < 8 || ftyp.end > 4096) throw new Malformed();
  r.need(ftyp.start, ftyp.end - ftyp.start);
  const brands = new Set<string>([r.ascii(ftyp.payload, 4)]);
  for (let o = ftyp.payload + 8; o + 4 <= ftyp.end; o += 4) brands.add(r.ascii(o, 4));

  const has = (set: Set<string>) => [...brands].some((b) => set.has(b));
  const major = r.ascii(ftyp.payload, 4);
  if (!has(HEIC_BRANDS)) {
    if (brands.has('avif') || brands.has('avis')) return reject('unsupported_type');
    if (!has(HEIF_STRUCTURE_BRANDS)) {
      if (VIDEO_BRANDS.has(major) || has(VIDEO_BRANDS)) return reject('unsupported_type');
      // An ftyp image container whose brands we don't recognise as decodable HEIC.
      return reject('heic_unsupported_variant');
    }
    if (has(HEIF_UNSUPPORTED_BRANDS)) return reject('heic_unsupported_variant');
  }

  let dimensions: { width: number; height: number } | null = null;
  try {
    let offset = ftyp.end;
    while (offset + 8 <= r.length) {
      const box = readBox(r, offset, Number.MAX_SAFE_INTEGER);
      if (box.type === 'meta') {
        dimensions = heifDimensions(r, box);
        break;
      }
      offset = box.end;
    }
  } catch (error) {
    if (!(error instanceof Truncated)) throw error;
  }
  return withPixelLimit({
    ok: true,
    mime: 'image/heic',
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  });
}

// ---------------------------------------------------------------- entry points

/**
 * Detect the real image type from the first bytes of a file. Never throws.
 *
 * `truncated` means a required header structure runs past the end of `bytes`. Pass at least
 * `IMAGE_VALIDATION.sniffBytes` (or the whole file if smaller) so that only genuinely short
 * files are reported as truncated.
 */
export function sniffImage(bytes: Uint8Array): SniffResult {
  const r = new Reader(bytes);
  try {
    if (startsWith(bytes, JPEG_SIGNATURE)) return sniffJpeg(r);
    if (startsWith(bytes, PNG_SIGNATURE)) return sniffPng(r);
    if (startsWith(bytes, RIFF) && bytes.length >= 12 && r.ascii(8, 4) === 'WEBP') {
      return sniffWebp(r);
    }
    if (bytes.length >= 12 && r.ascii(4, 4) === 'ftyp') return sniffHeif(r);
    if (bytes.length < 12) {
      // A short read that could still become a supported signature is a truncated file.
      const couldBe =
        bytes.length === 0 ||
        isPrefixOf(bytes, JPEG_SIGNATURE) ||
        isPrefixOf(bytes, PNG_SIGNATURE) ||
        isPrefixOf(bytes, RIFF) ||
        startsWith(bytes, RIFF) ||
        (bytes.length > 4 && isPrefixOf(bytes.subarray(4), FTYP)) ||
        (bytes.length >= 8 && startsWith(bytes, FTYP, 4));
      if (couldBe) return reject('truncated');
    }
    return reject('unsupported_type');
  } catch (error) {
    if (error instanceof Truncated) return reject('truncated');
    return reject('malformed');
  }
}

const EXTENSION_SET: ReadonlySet<string> = new Set(ACCEPTED_PHOTO_EXTENSIONS);

/** Case-insensitive check of the filename's final extension against FR-M01 formats. */
export function isAcceptedExtension(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return false;
  return EXTENSION_SET.has(filename.slice(dot + 1).toLowerCase());
}

export interface PrecheckInput {
  name: string;
  size: number;
  /** Browser-reported MIME type. Informational only: the real type comes from the bytes. */
  type?: string;
}

export type PrecheckResult = SniffedImage | { ok: false; code: MediaRejectionCode };

/**
 * Client-side pre-check before an upload starts (FR-M01, FR-M08): extension, size and magic
 * bytes. Pass the first `IMAGE_VALIDATION.sniffBytes` of the file. Advisory only — the worker
 * repeats `sniffImage` authoritatively on the stored object.
 */
export function precheckFile(file: PrecheckInput, firstBytes: Uint8Array): PrecheckResult {
  if (!isAcceptedExtension(file.name)) return { ok: false, code: 'unsupported_extension' };
  if (!Number.isSafeInteger(file.size) || file.size < 1) return { ok: false, code: 'empty_file' };
  if (file.size > UPLOAD_LIMITS.maxPhotoBytes) return { ok: false, code: 'file_too_large' };
  return sniffImage(firstBytes);
}
