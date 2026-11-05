import type { PublicMediaItem } from '@lumra/contracts';
import { buildResponsiveImage, type ResponsiveImage } from '@lumra/domain';

/** Alt text is filename-based, or neutral when unknown (PRD §12; never AI descriptions). */
export function altText(item: Pick<PublicMediaItem, 'filename'>): string {
  const name = item.filename.trim();
  return name.length > 0 ? name : 'Photo';
}

/** Accessible label for a grid tile / lightbox slide, by recipient-visible status. */
export function itemLabel(item: Pick<PublicMediaItem, 'status' | 'filename'>): string {
  if (item.status === 'pending') return 'Photo still processing';
  if (item.status === 'unavailable') return 'Photo unavailable';
  return altText(item);
}

/**
 * `src`/`srcset`/`sizes` for a ready item rendered `boxWidth` CSS px wide. Variant URLs come
 * from the payload as-is (short-lived gateway URLs); returns `null` for non-ready items.
 */
export function responsiveImageFor(
  item: PublicMediaItem,
  boxWidth: number,
  dpr = 1,
): ResponsiveImage | null {
  if (item.status !== 'ready' || item.variants.length === 0) return null;
  const urls = new Map(item.variants.map((v) => [v.width, v.url]));
  return buildResponsiveImage(
    { boxWidth, dpr, availableWidths: [...urls.keys()] },
    (width) => urls.get(width) as string,
  );
}

/** Current device pixel ratio (1 during SSR). */
export function devicePixelRatio(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
}
