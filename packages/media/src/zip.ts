import { crc32 as jsCrc32, type Crc32Fn } from './crc32';

/**
 * Streaming STORE-mode ZIP writer (FR-D02/D03, ADR-003). Web APIs only, so it runs in the job
 * Worker and in Node tests.
 *
 * - **No recompression:** every entry uses method 0 (stored). JPEG/HEIC/WebP/PNG are already
 *   compressed; deflating them costs CPU for ~0 % gain and would change nothing a recipient sees.
 * - **Streaming:** each entry's bytes are forwarded to the sink as they arrive; the CRC-32 is
 *   computed incrementally, so local headers carry general-purpose bit 3 and the CRC and sizes
 *   follow the data in a data descriptor (APPNOTE 4.3.9). Memory is O(entries) for the central
 *   directory, never O(bytes).
 * - **ZIP64** (APPNOTE 4.5.3) per entry when its size or header offset doesn't fit 32 bits, and
 *   for the end records when the directory's size/offset or entry count doesn't. `forceZip64`
 *   exercises the same paths in tests without writing 4 GiB.
 * - Names are written as UTF-8 (bit 11). Callers pass already-sanitized single path components
 *   (`@lumra/domain` sanitizeArchiveFilename); the writer also refuses separators and `..`.
 */

export type ZipSink = (chunk: Uint8Array) => Promise<void> | void;

export interface ZipEntryInput {
  /** Entry name: one path component, UTF-8. */
  name: string;
  /** Exact byte size of the body; checked against what is actually streamed. */
  size: number;
  /** Modification time (stored as MS-DOS date/time in UTC). Defaults to 1980-01-01. */
  modifiedAt?: Date;
}

export interface ZipWriterOptions {
  /** CRC-32 implementation; defaults to the pure-JS slice-by-8 one. */
  crc32?: Crc32Fn;
  /** Write ZIP64 structures even when not required (tests). */
  forceZip64?: boolean;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD = 0x06054b50;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
/** bit 3: sizes/CRC in data descriptor; bit 11: UTF-8 names. */
const FLAGS = 0x0808;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
/** "Made by" Unix (3) so extractors apply the external attributes below. */
const MADE_BY_UNIX = 3 << 8;
/** Regular file, rw-r--r--. */
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;
const MAX_NAME_BYTES = U16_MAX;

interface CentralRecord {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
  zip64Entry: boolean;
}

const encoder = new TextEncoder();

function dosDateTime(date: Date | undefined): { dosTime: number; dosDate: number } {
  const d = date && !Number.isNaN(date.getTime()) ? date : new Date(Date.UTC(1980, 0, 1));
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  if (d.getUTCFullYear() < 1980) return { dosTime: 0, dosDate: (1 << 5) | 1 };
  return {
    dosTime: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

function u64(view: DataView, at: number, value: number): void {
  view.setBigUint64(at, BigInt(value), true);
}

async function* chunksOf(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value && value.byteLength > 0) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of body) if (chunk.byteLength > 0) yield chunk;
  }
}

export class ZipStreamWriter {
  private readonly crc32: Crc32Fn;
  private readonly forceZip64: boolean;
  private readonly records: CentralRecord[] = [];
  private written = 0;
  private finished = false;
  private busy = false;

  constructor(
    private readonly sink: ZipSink,
    options: ZipWriterOptions = {},
  ) {
    this.crc32 = options.crc32 ?? jsCrc32;
    this.forceZip64 = options.forceZip64 ?? false;
  }

  /** Bytes emitted so far. */
  get bytesWritten(): number {
    return this.written;
  }

  get entryCount(): number {
    return this.records.length;
  }

  private async emit(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return;
    await this.sink(chunk);
    this.written += chunk.byteLength;
  }

  /**
   * Streams one stored entry. `onProgress` is called with the entry bytes forwarded so far.
   * Throws `ZipFormatError` when the body is longer or shorter than `entry.size`; the archive is
   * then unusable and the caller must discard it.
   */
  async addEntry(
    entry: ZipEntryInput,
    body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    onProgress?: (entryBytes: number) => void,
  ): Promise<{ crc32: number; size: number }> {
    if (this.finished) throw new ZipFormatError('archive already finished');
    if (this.busy) throw new ZipFormatError('entries must be added one at a time');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new ZipFormatError('entry size must be a non-negative safe integer');
    }
    if (
      !entry.name ||
      /[\\/]/.test(entry.name) ||
      entry.name.includes('\0') ||
      entry.name === '.' ||
      entry.name === '..'
    ) {
      throw new ZipFormatError('entry name must be a single safe path component');
    }
    const name = encoder.encode(entry.name);
    if (name.byteLength > MAX_NAME_BYTES) throw new ZipFormatError('entry name too long');
    this.busy = true;
    try {
      const offset = this.written;
      const zip64Entry = this.forceZip64 || entry.size >= U32_MAX || offset >= U32_MAX;
      const { dosTime, dosDate } = dosDateTime(entry.modifiedAt);

      // Local file header (APPNOTE 4.3.7) with zeroed CRC/sizes (bit 3).
      const extraLen = zip64Entry ? 20 : 0;
      const header = new Uint8Array(30 + name.byteLength + extraLen);
      const h = new DataView(header.buffer);
      h.setUint32(0, SIG_LOCAL, true);
      h.setUint16(4, zip64Entry ? VERSION_ZIP64 : VERSION_DEFAULT, true);
      h.setUint16(6, FLAGS, true);
      h.setUint16(8, 0, true); // method: stored
      h.setUint16(10, dosTime, true);
      h.setUint16(12, dosDate, true);
      h.setUint32(14, 0, true);
      h.setUint32(18, zip64Entry ? U32_MAX : 0, true);
      h.setUint32(22, zip64Entry ? U32_MAX : 0, true);
      h.setUint16(26, name.byteLength, true);
      h.setUint16(28, extraLen, true);
      header.set(name, 30);
      if (zip64Entry) {
        const at = 30 + name.byteLength;
        h.setUint16(at, 0x0001, true);
        h.setUint16(at + 2, 16, true);
        u64(h, at + 4, 0);
        u64(h, at + 12, 0);
      }
      await this.emit(header);

      let crc = 0;
      let size = 0;
      for await (const chunk of chunksOf(body)) {
        size += chunk.byteLength;
        if (size > entry.size) throw new ZipFormatError('entry body longer than declared size');
        crc = this.crc32(chunk, crc);
        await this.emit(chunk);
        onProgress?.(size);
      }
      if (size !== entry.size) throw new ZipFormatError('entry body shorter than declared size');

      // Data descriptor (APPNOTE 4.3.9); 8-byte sizes for ZIP64 entries.
      const descriptor = new Uint8Array(zip64Entry ? 24 : 16);
      const d = new DataView(descriptor.buffer);
      d.setUint32(0, SIG_DESCRIPTOR, true);
      d.setUint32(4, crc, true);
      if (zip64Entry) {
        u64(d, 8, size);
        u64(d, 16, size);
      } else {
        d.setUint32(8, size, true);
        d.setUint32(12, size, true);
      }
      await this.emit(descriptor);

      this.records.push({ name, crc, size, offset, dosTime, dosDate, zip64Entry });
      return { crc32: crc, size };
    } finally {
      this.busy = false;
    }
  }

  /** Writes the central directory and end records. Returns the archive's total size. */
  async finish(): Promise<number> {
    if (this.finished) throw new ZipFormatError('archive already finished');
    if (this.busy) throw new ZipFormatError('an entry is still being written');
    this.finished = true;
    const cdOffset = this.written;

    for (const r of this.records) {
      const needSize = this.forceZip64 || r.size >= U32_MAX;
      const needOffset = this.forceZip64 || r.offset >= U32_MAX;
      const zip64Fields = (needSize ? 2 : 0) + (needOffset ? 1 : 0);
      const extraLen = zip64Fields > 0 ? 4 + zip64Fields * 8 : 0;
      const version = r.zip64Entry || zip64Fields > 0 ? VERSION_ZIP64 : VERSION_DEFAULT;
      const rec = new Uint8Array(46 + r.name.byteLength + extraLen);
      const v = new DataView(rec.buffer);
      v.setUint32(0, SIG_CENTRAL, true);
      v.setUint16(4, MADE_BY_UNIX | version, true);
      v.setUint16(6, version, true);
      v.setUint16(8, FLAGS, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, r.dosTime, true);
      v.setUint16(14, r.dosDate, true);
      v.setUint32(16, r.crc, true);
      v.setUint32(20, needSize ? U32_MAX : r.size, true);
      v.setUint32(24, needSize ? U32_MAX : r.size, true);
      v.setUint16(28, r.name.byteLength, true);
      v.setUint16(30, extraLen, true);
      v.setUint16(32, 0, true); // comment
      v.setUint16(34, 0, true); // disk number start
      v.setUint16(36, 0, true); // internal attributes
      v.setUint32(38, EXTERNAL_ATTRS, true);
      v.setUint32(42, needOffset ? U32_MAX : r.offset, true);
      rec.set(r.name, 46);
      if (extraLen > 0) {
        let at = 46 + r.name.byteLength;
        v.setUint16(at, 0x0001, true);
        v.setUint16(at + 2, zip64Fields * 8, true);
        at += 4;
        // Order is fixed by APPNOTE 4.5.3: uncompressed, compressed, offset.
        if (needSize) {
          u64(v, at, r.size);
          u64(v, at + 8, r.size);
          at += 16;
        }
        if (needOffset) u64(v, at, r.offset);
      }
      await this.emit(rec);
    }

    const cdSize = this.written - cdOffset;
    const count = this.records.length;
    const zip64End =
      this.forceZip64 || count >= U16_MAX || cdSize >= U32_MAX || cdOffset >= U32_MAX;

    if (zip64End) {
      const eocd64Offset = this.written;
      const tail = new Uint8Array(56 + 20);
      const t = new DataView(tail.buffer);
      t.setUint32(0, SIG_EOCD64, true);
      u64(t, 4, 44); // size of the remaining record
      t.setUint16(12, MADE_BY_UNIX | VERSION_ZIP64, true);
      t.setUint16(14, VERSION_ZIP64, true);
      t.setUint32(16, 0, true);
      t.setUint32(20, 0, true);
      u64(t, 24, count);
      u64(t, 32, count);
      u64(t, 40, cdSize);
      u64(t, 48, cdOffset);
      t.setUint32(56, SIG_EOCD64_LOCATOR, true);
      t.setUint32(60, 0, true);
      u64(t, 64, eocd64Offset);
      t.setUint32(72, 1, true);
      await this.emit(tail);
    }

    const eocd = new Uint8Array(22);
    const e = new DataView(eocd.buffer);
    e.setUint32(0, SIG_EOCD, true);
    e.setUint16(4, 0, true);
    e.setUint16(6, 0, true);
    e.setUint16(8, zip64End ? U16_MAX : count, true);
    e.setUint16(10, zip64End ? U16_MAX : count, true);
    e.setUint32(12, zip64End ? U32_MAX : cdSize, true);
    e.setUint32(16, zip64End ? U32_MAX : cdOffset, true);
    e.setUint16(20, 0, true);
    await this.emit(eocd);
    return this.written;
  }
}

/** Exact size of a STORE archive with these entries (bit 3 descriptors, no ZIP64). */
export function storedZipSize(entries: readonly { name: string; size: number }[]): number {
  let total = 22;
  for (const e of entries) {
    const n = encoder.encode(e.name).byteLength;
    total += 30 + n + e.size + 16 + 46 + n;
  }
  return total;
}
