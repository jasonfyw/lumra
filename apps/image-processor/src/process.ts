import { createHash } from 'node:crypto';
import sharp, { type Metadata, type SharpOptions } from 'sharp';
import {
  DERIVATIVE_ENCODING,
  IMAGE_VALIDATION,
  PROCESSOR_LIMITS,
  type AcceptedPhotoMime,
} from '@lumra/config';
import type { ProcessManifest, ProcessRequestParams, ProcessorErrorCode } from '@lumra/contracts';
import { planDerivatives, sniffImage } from '@lumra/media';
import { extractTakenAt } from './exif';

// One job at a time per instance (PROCESSOR_LIMITS.maxConcurrentJobs): no cross-request libvips
// cache, and a bounded thread pool so a single large decode can't starve the instance.
sharp.cache(false);
sharp.concurrency(PROCESSOR_LIMITS.vipsConcurrency);

export class ProcessingError extends Error {
  constructor(
    readonly code: ProcessorErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessingError';
  }
}

const reject = (code: ProcessorErrorCode, message: string) =>
  new ProcessingError(code, false, message);

export interface ProcessedOutput {
  manifest: ProcessManifest;
  /** Encoded bytes keyed by manifest `variants[].field`, in manifest order. */
  files: Map<string, Buffer>;
}

export interface ProcessOptions {
  timeoutMs?: number;
  maxPixels?: number;
  now?: number;
}

/**
 * Maps libvips/sharp failures to typed codes. Decoder-side errors are permanent rejections;
 * anything that looks like an environment problem stays retryable so a broken deploy never
 * marks user photos as failed.
 */
export function classifySharpError(error: unknown): ProcessingError {
  if (error instanceof ProcessingError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/pixel limit/i.test(message)) return reject('too_many_pixels', 'image exceeds pixel limit');
  if (/has not been built in|decoding plugin|no decoder/i.test(message)) {
    return new ProcessingError('processor_unavailable', true, 'HEVC decoder unavailable');
  }
  if (/timeout/i.test(message)) return reject('processing_timeout', 'processing timed out');
  if (/unsupported image format/i.test(message)) return reject('unsupported_type', 'unsupported');
  if (/premature end|truncated|unexpected end|end of (file|data)|not enough data/i.test(message)) {
    return reject('truncated', 'image data is truncated');
  }
  if (/jpeg|png|webp|heif|load|corrupt|invalid|bad |decode|marker|chunk|read/i.test(message)) {
    return reject('malformed', 'image could not be decoded');
  }
  return new ProcessingError('internal_error', true, 'internal processing error');
}

function mimeFor(metadata: Metadata): AcceptedPhotoMime {
  switch (metadata.format) {
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'heif':
      // Only HEVC-coded HEIF (iPhone HEIC) is accepted; AVIF and other HEIF codecs are not (FR-M05).
      if (metadata.compression === 'hevc') return 'image/heic';
      throw reject('heic_unsupported_variant', 'HEIF variant is not supported');
    default:
      throw reject('unsupported_type', 'unsupported image type');
  }
}

function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    work.catch(() => {});
    return Promise.reject(reject('processing_timeout', 'processing timed out'));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rejectTimeout) => {
    timer = setTimeout(
      () => rejectTimeout(reject('processing_timeout', 'processing timed out')),
      remaining,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The single master derivative pipeline (FR-M05/M06): decode once per variant with the pixel cap
 * enforced before decode, apply EXIF orientation, convert to sRGB using the embedded ICC profile,
 * resize without enlargement, encode WebP at a fixed quality and strip all metadata.
 */
export async function processImage(
  input: Buffer,
  params: ProcessRequestParams,
  options: ProcessOptions = {},
): Promise<ProcessedOutput> {
  const timeoutMs = options.timeoutMs ?? PROCESSOR_LIMITS.processTimeoutMs;
  const maxPixels = options.maxPixels ?? IMAGE_VALIDATION.maxPixels;
  const deadline = Date.now() + timeoutMs;
  if (input.length === 0) throw reject('empty_file', 'empty input');

  // Magic-byte gate before libvips sees the bytes: only the four accepted containers ever reach
  // a decoder, so loaders for other formats (GIF, TIFF, SVG, PDF, …) are unreachable.
  const sniffed = sniffImage(input.subarray(0, IMAGE_VALIDATION.sniffBytes));
  if (!sniffed.ok) throw reject(sniffed.code, 'input failed type sniffing');
  if (sniffed.width && sniffed.height && sniffed.width * sniffed.height > maxPixels) {
    throw reject('too_many_pixels', 'image exceeds pixel limit');
  }

  const inputOptions: SharpOptions = {
    limitInputPixels: maxPixels,
    // Tolerate recoverable decoder warnings (common in camera JPEGs); fail on real errors.
    failOn: 'error',
    autoOrient: true,
  };

  try {
    const metadata = await withDeadline(
      sharp(input, { ...inputOptions, autoOrient: false }).metadata(),
      deadline,
    );
    const mime = mimeFor(metadata);
    if (mime !== params.expectedMime) {
      // The worker's sniff and the decoder must agree (defence against polyglot files).
      throw reject('unsupported_type', 'decoded type does not match the sniffed type');
    }
    const { width, height } = metadata;
    if (!width || !height) throw reject('malformed', 'image has no dimensions');
    if (width * height > maxPixels) throw reject('too_many_pixels', 'image exceeds pixel limit');

    const orientation =
      metadata.orientation && metadata.orientation >= 1 && metadata.orientation <= 8
        ? metadata.orientation
        : null;
    const swap = orientation !== null && orientation >= 5;
    const displayWidth = metadata.autoOrient?.width ?? (swap ? height : width);
    const displayHeight = metadata.autoOrient?.height ?? (swap ? width : height);
    const takenAt = extractTakenAt(metadata.exif, options.now);

    const files = new Map<string, Buffer>();
    const variants: ProcessManifest['variants'] = [];
    for (const planned of planDerivatives(displayWidth, params.widths)) {
      const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      const { data, info } = await withDeadline(
        sharp(input, inputOptions)
          .timeout({ seconds })
          .resize({ width: planned.outputWidth, withoutEnlargement: true })
          // Uses the embedded ICC profile (if any) as the source space; output carries no profile.
          .toColourspace('srgb')
          .webp({ quality: DERIVATIVE_ENCODING.quality, effort: DERIVATIVE_ENCODING.effort })
          .toBuffer({ resolveWithObject: true }),
        deadline,
      );
      files.set(planned.variant, data);
      variants.push({
        variant: planned.variant,
        field: planned.variant,
        mime: DERIVATIVE_ENCODING.mime,
        width: info.width,
        height: info.height,
        byteSize: data.length,
      });
    }

    return {
      manifest: {
        mediaId: params.mediaId,
        source: {
          mime,
          width: displayWidth,
          height: displayHeight,
          orientation,
          takenAt,
          sha256: createHash('sha256').update(input).digest('hex'),
        },
        encoding: {
          format: DERIVATIVE_ENCODING.format,
          quality: DERIVATIVE_ENCODING.quality,
          pipelineVersion: DERIVATIVE_ENCODING.pipelineVersion,
        },
        variants,
      },
      files,
    };
  } catch (error) {
    throw classifySharpError(error);
  }
}
