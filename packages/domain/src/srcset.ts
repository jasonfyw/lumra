import { DERIVATIVE_WIDTHS } from '@lumra/config';

/**
 * Responsive thumbnail selection for grid tiles (PRD §4, T17). Variant URLs are supplied by
 * the caller (they are short-lived gateway URLs, never public bucket URLs).
 */
export interface ResponsiveImageInput {
  /** Rendered box width in CSS px (from the justified layout). */
  boxWidth: number;
  /** `window.devicePixelRatio`; clamped to `[1, maxDpr]`. */
  dpr?: number;
  /** Variant widths that exist for this item; defaults to `DERIVATIVE_WIDTHS`. */
  availableWidths?: readonly number[];
  /** Upper bound on DPR to save bandwidth on very dense screens. */
  maxDpr?: number;
}

export interface ResponsiveImage {
  /** Best single variant for this box/DPR (use as `src`). */
  src: string;
  width: number;
  /** `srcset` with `w` descriptors for every available variant, ascending. */
  srcSet: string;
  /** `sizes` attribute matching the laid-out box, e.g. `"220px"`. */
  sizes: string;
}

const DEFAULT_MAX_DPR = 3;

function normaliseWidths(widths: readonly number[]): number[] {
  return [...new Set(widths.filter((w) => Number.isInteger(w) && w > 0))].sort((a, b) => a - b);
}

/** Smallest variant ≥ `boxWidth × dpr`, or the largest available when none is big enough. */
export function pickVariantWidth(
  boxWidth: number,
  dpr = 1,
  availableWidths: readonly number[] = DERIVATIVE_WIDTHS,
  maxDpr = DEFAULT_MAX_DPR,
): number | null {
  const widths = normaliseWidths(availableWidths);
  if (widths.length === 0) return null;
  const ratio = Math.min(Math.max(Number.isFinite(dpr) ? dpr : 1, 1), Math.max(1, maxDpr));
  const needed = Math.max(0, boxWidth) * ratio;
  return widths.find((w) => w >= needed) ?? (widths[widths.length - 1] as number);
}

export function buildResponsiveImage(
  input: ResponsiveImageInput,
  urlForWidth: (width: number) => string,
): ResponsiveImage | null {
  const widths = normaliseWidths(input.availableWidths ?? DERIVATIVE_WIDTHS);
  const width = pickVariantWidth(input.boxWidth, input.dpr, widths, input.maxDpr);
  if (width === null) return null;
  return {
    src: urlForWidth(width),
    width,
    srcSet: widths.map((w) => `${urlForWidth(w)} ${w}w`).join(', '),
    sizes: `${Math.max(1, Math.round(input.boxWidth))}px`,
  };
}
