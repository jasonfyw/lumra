import { GALLERY_LIMITS } from '@lumra/config';
import type { PublicGallery, PublicMediaItem } from '@lumra/contracts';
import { selectCover } from '@lumra/domain';
import { altText, responsiveImageFor } from './media';

export interface GalleryHeroProps {
  gallery: Pick<PublicGallery, 'title' | 'coverMediaId'>;
  items: readonly PublicMediaItem[];
}

/** Width used to choose the hero's fallback `src`; `srcset` lets the browser pick per screen. */
const HERO_SRC_WIDTH = 1280;

/**
 * Hero cover + title (PRD §4 "Hero"). The cover is the creator's override when ready, else the
 * first ready photo by upload order (`selectCover`), else a neutral placeholder. Server-safe:
 * no hooks, no data fetching.
 */
export function GalleryHero({ gallery, items }: GalleryHeroProps) {
  const cover = selectCover(items, gallery.coverMediaId);
  const image = cover ? responsiveImageFor(cover, HERO_SRC_WIDTH) : null;
  const title = gallery.title.trim() || GALLERY_LIMITS.defaultTitle;
  const photoCount = items.length;

  return (
    <header>
      <div className="relative h-[min(68svh,760px)] min-h-56 w-full overflow-hidden bg-[var(--color-surface)]">
        {cover && image ? (
          // Gateway URLs with their own srcset; next/image would proxy media through Vercel.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.src}
            srcSet={image.srcSet}
            sizes="100vw"
            width={cover.width ?? undefined}
            height={cover.height ?? undefined}
            alt={altText(cover)}
            fetchPriority="high"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            role="img"
            aria-label="Cover photo not available yet"
            data-testid="hero-placeholder"
            className="h-full w-full bg-gradient-to-br from-[var(--color-surface)] to-[var(--color-line)]"
          />
        )}
      </div>
      <div className="px-4 pt-8 pb-6 sm:px-6 sm:pt-12 sm:pb-8 lg:px-10">
        <h1 className="max-w-5xl font-[family-name:var(--font-display)] text-4xl font-semibold tracking-tight text-balance break-words sm:text-6xl">
          {title}
        </h1>
        <p className="mt-3 text-sm text-[var(--color-ink-muted)] sm:text-base">
          {photoCount === 1 ? '1 photo' : `${photoCount.toLocaleString('en-US')} photos`}
        </p>
      </div>
    </header>
  );
}
