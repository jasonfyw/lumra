import { z } from 'zod';
import { ACCEPTED_PHOTO_MIME_TYPES, DERIVATIVE_ENCODING, DERIVATIVE_WIDTHS } from '@lumra/config';
import { PREVIEW_VARIANTS } from './media-token';
import { MEDIA_REJECTION_CODES } from './upload';

/**
 * Image-processor container contract (T12, ADR-002).
 *
 * Request: `POST /process` with the original bytes as the (streamed) body and the parameters
 * below as headers. Response on success: `multipart/form-data` whose first field is `manifest`
 * (JSON, `processManifestSchema`) followed by one `image/webp` file field per variant, named
 * after the variant (`w320`, …). Failures are JSON `processorErrorBodySchema` with status 422
 * (non-retryable rejection), 413 (too large) or 503/500 (retryable).
 */
export const PROCESSOR_PATH = '/process';

export const PROCESSOR_HEADERS = {
  mediaId: 'x-lumra-media-id',
  expectedMime: 'x-lumra-expected-mime',
  /** Comma-separated target widths, e.g. `320,640,1280,2048`. */
  widths: 'x-lumra-widths',
  traceId: 'x-request-id',
} as const;

const derivativeWidth = z
  .number()
  .int()
  .refine((w) => (DERIVATIVE_WIDTHS as readonly number[]).includes(w), 'unknown derivative width');

export const processRequestParamsSchema = z.object({
  mediaId: z.uuid(),
  expectedMime: z.enum(ACCEPTED_PHOTO_MIME_TYPES),
  widths: z.array(derivativeWidth).min(1).max(DERIVATIVE_WIDTHS.length),
  traceId: z.string().min(1).max(128),
});
export type ProcessRequestParams = z.infer<typeof processRequestParamsSchema>;

export const processedVariantSchema = z.object({
  variant: z.enum(PREVIEW_VARIANTS),
  /** Form field holding the bytes (equals `variant`). */
  field: z.string().regex(/^[a-z0-9]{1,16}$/),
  mime: z.literal(DERIVATIVE_ENCODING.mime),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteSize: z.number().int().positive(),
});
export type ProcessedVariant = z.infer<typeof processedVariantSchema>;

export const processManifestSchema = z.object({
  mediaId: z.uuid(),
  source: z.object({
    /** Decoded format, which may differ from the declared MIME (the bytes are authoritative). */
    mime: z.enum(ACCEPTED_PHOTO_MIME_TYPES),
    /** Display dimensions, i.e. after EXIF orientation is applied. */
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** EXIF orientation of the original (1–8), null when absent. */
    orientation: z.number().int().min(1).max(8).nullable(),
    /** EXIF DateTimeOriginal (+ OffsetTimeOriginal when present) as UTC, null when absent. */
    takenAt: z.iso.datetime().nullable(),
  }),
  encoding: z.object({
    format: z.literal(DERIVATIVE_ENCODING.format),
    quality: z.number().int().min(1).max(100),
    pipelineVersion: z.number().int().positive(),
  }),
  variants: z.array(processedVariantSchema).min(1).max(DERIVATIVE_WIDTHS.length),
});
export type ProcessManifest = z.infer<typeof processManifestSchema>;

/** Rejections are permanent: the media is marked `failed` with this code. */
export const PROCESSOR_REJECTION_CODES = MEDIA_REJECTION_CODES;
/** Transient failures: the queue retries with backoff, then dead-letters. */
export const PROCESSOR_TRANSIENT_CODES = [
  'processor_busy',
  'processor_unavailable',
  'internal_error',
] as const;
export const PROCESSOR_ERROR_CODES = [
  ...PROCESSOR_REJECTION_CODES,
  ...PROCESSOR_TRANSIENT_CODES,
  'bad_request',
] as const;
export type ProcessorErrorCode = (typeof PROCESSOR_ERROR_CODES)[number];

export const processorErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(PROCESSOR_ERROR_CODES),
    retryable: z.boolean(),
    message: z.string().max(500),
  }),
});
export type ProcessorErrorBody = z.infer<typeof processorErrorBodySchema>;
