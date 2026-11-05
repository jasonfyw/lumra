import { readFileSync } from 'node:fs';
import { crc32, inflateSync } from 'node:zlib';
import sharp from 'sharp';

export const MEDIA_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

export const HEIC_FIXTURE = readFileSync(
  new URL('./fixtures/gradient-400x300.heic', import.meta.url),
);

/** sharp's prebuilt libvips ships libheif without an HEVC decoder; the container image has one. */
export async function canDecodeHevc(): Promise<boolean> {
  try {
    await sharp(HEIC_FIXTURE).raw().toBuffer();
    return true;
  } catch {
    return false;
  }
}

/**
 * A `width`×`height` image whose stored top-left 1/5 corner is pure red on a blue background, so
 * a test can tell where the stored origin ended up after orientation is applied.
 */
export async function markerImage(width: number, height: number) {
  const marker = await sharp({
    create: {
      width: Math.round(width / 5),
      height: Math.round(height / 5),
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 255 } } })
    .composite([{ input: marker, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

export async function jpegWithOrientation(width: number, height: number, orientation: number) {
  return sharp(await markerImage(width, height))
    .jpeg({ quality: 95 })
    .withMetadata({ orientation })
    .toBuffer();
}

/** JPEG carrying EXIF capture time, GPS position, camera fields and an XMP-free APP1. */
export async function jpegWithExif(width = 800, height = 600) {
  return sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 60 } } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'LumraCam', Model: 'Test 1', Copyright: 'secret-owner' },
      IFD2: { DateTimeOriginal: '2024:05:06 07:08:09', OffsetTimeOriginal: '+02:00' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '51/1 30/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 7/1 0/1',
      },
    })
    .toBuffer();
}

/** Encode a flat sRGB colour as a PNG tagged with (and converted to) Display P3. */
export async function p3TaggedPng(rgb: { r: number; g: number; b: number }) {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: rgb } })
    .withIccProfile('p3')
    .png()
    .toBuffer();
}

/**
 * Stored (un-colour-managed) RGB of the first pixel of an 8-bit RGB PNG, read without libvips.
 * Row 0 / column 0 is identical to the raw bytes for every PNG filter type.
 */
export function firstPixelOfPng(png: Buffer) {
  const idat: Buffer[] = [];
  for (let off = 8; off < png.length;) {
    const length = png.readUInt32BE(off);
    if (png.toString('ascii', off + 4, off + 8) === 'IDAT') {
      idat.push(png.subarray(off + 8, off + 8 + length));
    }
    off += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { r: raw[1]!, g: raw[2]!, b: raw[3]! };
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Decompression-bomb stand-in: a structurally valid PNG header declaring `width`×`height`
 * pixels with almost no data. Nothing should ever try to decode it.
 */
export function pngBomb(width = 50_000, height = 50_000): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Mean RGB of a `size`×`size` box at (`left`, `top`) of an encoded image. */
export async function sampleRgb(image: Buffer, left: number, top: number, size = 4) {
  const { data, info } = await sharp(image)
    .extract({ left, top, width: size, height: size })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += info.channels) {
    sum[0]! += data[i]!;
    sum[1]! += data[i + 1]!;
    sum[2]! += data[i + 2]!;
  }
  const n = data.length / info.channels;
  return { r: sum[0]! / n, g: sum[1]! / n, b: sum[2]! / n };
}
