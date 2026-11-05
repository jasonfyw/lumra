import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { processManifestSchema, type ProcessRequestParams } from '@lumra/contracts';
import { sniffImage } from '@lumra/media';
import { classifySharpError, processImage, ProcessingError } from '../src/process';
import { extractTakenAt } from '../src/exif';
import {
  HEIC_FIXTURE,
  MEDIA_ID,
  canDecodeHevc,
  firstPixelOfPng,
  jpegWithExif,
  jpegWithOrientation,
  p3TaggedPng,
  pngBomb,
  sampleRgb,
} from './fixtures';

const params = (overrides: Partial<ProcessRequestParams> = {}): ProcessRequestParams => ({
  mediaId: MEDIA_ID,
  expectedMime: 'image/jpeg',
  widths: [320, 640, 1280, 2048],
  traceId: 'test',
  ...overrides,
});

async function expectRejection(promise: Promise<unknown>, code: string, retryable = false) {
  await expect(promise).rejects.toMatchObject({ name: 'ProcessingError', code, retryable });
}

function p3ToSrgb(c: { r: number; g: number; b: number }) {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const enc = (v: number) => {
    const x = Math.min(1, Math.max(0, v));
    return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  };
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)];
  return {
    r: enc(1.2249 * r - 0.2247 * g),
    g: enc(-0.042 * r + 1.0419 * g),
    b: enc(-0.0197 * r - 0.0786 * g + 1.0979 * b),
  };
}

const isRed = (c: { r: number; g: number; b: number }) => c.r > 200 && c.g < 60 && c.b < 60;
const isBlue = (c: { r: number; g: number; b: number }) => c.b > 200 && c.r < 60 && c.g < 60;

describe('processImage — orientation (golden)', () => {
  it('applies EXIF orientation 6 (rotate 90° CW): stored top-left ends up top-right', async () => {
    const input = await jpegWithOrientation(1500, 1000, 6);
    const { manifest, files } = await processImage(input, params());
    expect(manifest.source).toMatchObject({ width: 1000, height: 1500, orientation: 6 });
    expect(manifest.variants.map((v) => [v.variant, v.width, v.height])).toEqual([
      ['w320', 320, 480],
      ['w640', 640, 960],
    ]);
    const w640 = files.get('w640')!;
    expect(isRed(await sampleRgb(w640, 640 - 20, 10))).toBe(true);
    expect(isBlue(await sampleRgb(w640, 10, 10))).toBe(true);
    expect(isBlue(await sampleRgb(w640, 640 - 20, 960 - 20))).toBe(true);
  });

  it('applies EXIF orientation 8 (rotate 90° CCW): stored top-left ends up bottom-left', async () => {
    const input = await jpegWithOrientation(1500, 1000, 8);
    const { manifest, files } = await processImage(input, params());
    expect(manifest.source).toMatchObject({ width: 1000, height: 1500, orientation: 8 });
    const w320 = files.get('w320')!;
    const meta = await sharp(w320).metadata();
    expect([meta.width, meta.height]).toEqual([320, 480]);
    expect(isRed(await sampleRgb(w320, 10, 480 - 20))).toBe(true);
    expect(isBlue(await sampleRgb(w320, 10, 10))).toBe(true);
    expect(isBlue(await sampleRgb(w320, 320 - 20, 480 - 20))).toBe(true);
  });
});

describe('processImage — colour (golden)', () => {
  it('converts a Display P3 tagged image to sRGB', async () => {
    const input = await p3TaggedPng({ r: 200, g: 60, b: 40 });
    const inputMeta = await sharp(input).metadata();
    expect(inputMeta.hasProfile).toBe(true);
    // Stored P3 code values, read without libvips (which would colour-manage them).
    const p3 = firstPixelOfPng(input);

    const { files } = await processImage(input, params({ expectedMime: 'image/png' }));
    const out = files.get('w320')!;
    const outMeta = await sharp(out).metadata();
    expect(outMeta.format).toBe('webp');
    expect(outMeta.hasProfile).toBe(false);

    // Independent reference: Display P3 and sRGB share the D65 white point and transfer curve,
    // so the conversion is linearise → 3×3 matrix → re-encode.
    const expected = p3ToSrgb(p3);
    const rgb = await sampleRgb(out, 30, 30);
    expect(Math.abs(rgb.r - expected.r)).toBeLessThanOrEqual(4);
    expect(Math.abs(rgb.g - expected.g)).toBeLessThanOrEqual(4);
    expect(Math.abs(rgb.b - expected.b)).toBeLessThanOrEqual(4);
    // …and a pipeline that ignored the profile would be far off.
    expect(Math.abs(expected.r - p3.r) + Math.abs(expected.g - p3.g)).toBeGreaterThan(20);
  });
});

describe('processImage — metadata', () => {
  it('strips EXIF/GPS/ICC/XMP from every derivative and extracts taken_at', async () => {
    const input = await jpegWithExif(800, 600);
    const inputMeta = await sharp(input).metadata();
    expect(inputMeta.exif).toBeDefined();

    const { manifest, files } = await processImage(input, params());
    expect(manifest.source.takenAt).toBe('2024-05-06T05:08:09.000Z');
    expect(manifest.source.orientation ?? 1).toBe(1);
    for (const bytes of files.values()) {
      const meta = await sharp(bytes).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.iptc).toBeUndefined();
      const text = bytes.toString('latin1');
      expect(text).not.toContain('Exif');
      expect(text).not.toContain('LumraCam');
      expect(text).not.toContain('secret-owner');
    }
    expect(processManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('ignores implausible capture times and malformed EXIF', () => {
    expect(extractTakenAt(undefined)).toBeNull();
    expect(extractTakenAt(Buffer.from('garbage'))).toBeNull();
  });
});

describe('processImage — sizing', () => {
  it('never upscales and keeps one native-width preview for small sources', async () => {
    const small = await sharp({
      create: { width: 200, height: 100, channels: 3, background: '#808080' },
    })
      .webp()
      .toBuffer();
    const { manifest } = await processImage(small, params({ expectedMime: 'image/webp' }));
    expect(manifest.variants).toEqual([
      expect.objectContaining({ variant: 'w320', width: 200, height: 100 }),
    ]);
  });

  it('produces all four widths for a large source and encodes WebP at the configured quality', async () => {
    const big = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#336699' },
    })
      .jpeg()
      .toBuffer();
    const { manifest, files } = await processImage(big, params());
    expect(manifest.variants.map((v) => v.width)).toEqual([320, 640, 1280, 2048]);
    expect(manifest.encoding).toEqual({ format: 'webp', quality: 80, pipelineVersion: 1 });
    for (const v of manifest.variants) expect(files.get(v.field)!.length).toBe(v.byteSize);
  });

  it('only renders requested widths', async () => {
    const big = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#336699' },
    })
      .jpeg()
      .toBuffer();
    const { manifest } = await processImage(big, params({ widths: [640] }));
    expect(manifest.variants.map((v) => v.variant)).toEqual(['w640']);
  });
});

describe('processImage — rejection', () => {
  it('rejects a decompression bomb before decoding', async () => {
    const bomb = pngBomb();
    const started = Date.now();
    await expectRejection(
      processImage(bomb, params({ expectedMime: 'image/png' })),
      'too_many_pixels',
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('enforces the pixel cap through sharp as well', async () => {
    const img = await sharp({
      create: { width: 400, height: 400, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    await expectRejection(
      processImage(img, params({ expectedMime: 'image/png' }), { maxPixels: 10_000 }),
      'too_many_pixels',
    );
  });

  it('rejects unsupported, empty, corrupt and mismatched input with typed codes', async () => {
    await expectRejection(processImage(Buffer.from('GIF89a......'), params()), 'unsupported_type');
    await expectRejection(processImage(Buffer.alloc(0), params()), 'empty_file');
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } })
      .jpeg()
      .toBuffer();
    const corrupt = Buffer.concat([jpeg.subarray(0, 200), Buffer.alloc(400, 0x55)]);
    await expect(processImage(corrupt, params())).rejects.toBeInstanceOf(ProcessingError);
    await expectRejection(
      processImage(jpeg, params({ expectedMime: 'image/png' })),
      'unsupported_type',
    );
  });

  it('rejects AVIF (HEIF container, AV1 codec) at the magic-byte gate', async () => {
    const avif = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#f00' } })
      .heif({ compression: 'av1' })
      .toBuffer();
    await expectRejection(
      processImage(avif, params({ expectedMime: 'image/heic' })),
      'unsupported_type',
    );
  });

  it('times out instead of hanging', async () => {
    const big = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#123' },
    })
      .png()
      .toBuffer();
    await expectRejection(
      processImage(big, params({ expectedMime: 'image/png' }), { timeoutMs: 1 }),
      'processing_timeout',
    );
  });

  it('classifies a missing HEVC decoder as retryable, never as a user-facing failure', () => {
    const error = classifySharpError(
      new Error('heif: Support for this compression format has not been built in: HEVC'),
    );
    expect(error).toMatchObject({ code: 'processor_unavailable', retryable: true });
    expect(classifySharpError(new Error('something odd'))).toMatchObject({
      code: 'internal_error',
      retryable: true,
    });
  });
});

describe('processImage — HEIC', () => {
  it('the committed HEIC fixture passes the authoritative sniff', () => {
    expect(sniffImage(new Uint8Array(HEIC_FIXTURE))).toMatchObject({
      ok: true,
      mime: 'image/heic',
    });
  });

  it('decodes HEIC when the HEVC decoder is present (container image), else stays retryable', async () => {
    const run = processImage(HEIC_FIXTURE, params({ expectedMime: 'image/heic' }));
    if (await canDecodeHevc()) {
      const { manifest } = await run;
      expect(manifest.source).toMatchObject({ mime: 'image/heic', width: 400, height: 300 });
      expect(manifest.variants.map((v) => [v.variant, v.width, v.height])).toEqual([
        ['w320', 320, 240],
      ]);
    } else {
      await expectRejection(run, 'processor_unavailable', true);
    }
  });
});
