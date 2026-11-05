import { DERIVATIVE_ENCODING, DERIVATIVE_WIDTHS } from '@lumra/config';
import { PREVIEW_VARIANTS, type MediaVariant } from '@lumra/contracts';
import { derivativeKey } from './keys';

/**
 * Derivative specs shared by the processor container and the queue consumer (FR-M06, T12).
 * Pure TypeScript with no Node built-ins so it runs in Workers, Node and the browser.
 */
export type PreviewVariant = (typeof PREVIEW_VARIANTS)[number];

export interface PlannedDerivative {
  variant: PreviewVariant;
  /** Nominal width of the variant (320/640/1280/2048). */
  targetWidth: number;
  /** Width actually produced: `min(targetWidth, sourceWidth)` — never upscaled. */
  outputWidth: number;
}

export function variantForWidth(width: number): PreviewVariant {
  const variant = `w${width}`;
  if (!(PREVIEW_VARIANTS as readonly string[]).includes(variant)) {
    throw new Error(`No preview variant for width ${width}`);
  }
  return variant as PreviewVariant;
}

export function isPreviewVariant(value: MediaVariant | string): value is PreviewVariant {
  return (PREVIEW_VARIANTS as readonly string[]).includes(value);
}

/**
 * Widths to produce for a source of `sourceWidth` display pixels: every requested width that
 * does not exceed the source. A source narrower than the smallest width still gets the smallest
 * variant, at its native width, so every ready photo has at least one preview.
 */
export function planDerivatives(
  sourceWidth: number,
  widths: readonly number[] = DERIVATIVE_WIDTHS,
): PlannedDerivative[] {
  if (!Number.isInteger(sourceWidth) || sourceWidth < 1) {
    throw new Error('sourceWidth must be a positive integer');
  }
  const sorted = [...new Set(widths)].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error('at least one derivative width is required');
  const fitting = sorted.filter((w) => w <= sourceWidth);
  const chosen = fitting.length > 0 ? fitting : [sorted[0] as number];
  return chosen.map((targetWidth) => ({
    variant: variantForWidth(targetWidth),
    targetWidth,
    outputWidth: Math.min(targetWidth, sourceWidth),
  }));
}

/** 32-bit FNV-1a; stable across runtimes and fast enough for short spec strings. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Stable variant hash for `derivativeKey`: the variant name plus a short hash of
 * width + format + quality + pipeline version, e.g. `w640k3x9q1z`. Changing any encoder setting
 * yields a new object key, so CDN/browser caches never mix pixels from two pipeline versions.
 */
export function derivativeVariantHash(
  variant: PreviewVariant,
  encoding: { format: string; quality: number; pipelineVersion: number } = DERIVATIVE_ENCODING,
): string {
  const spec = `${variant}|${encoding.format}|q${encoding.quality}|v${encoding.pipelineVersion}`;
  return `${variant}${fnv1a32(spec).toString(36).padStart(7, '0')}`;
}

export function derivativeObjectKey(
  galleryId: string,
  mediaId: string,
  variant: PreviewVariant,
): string {
  return derivativeKey(galleryId, mediaId, derivativeVariantHash(variant));
}
