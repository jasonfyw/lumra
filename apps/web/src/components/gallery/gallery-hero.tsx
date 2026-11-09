import { GALLERY_LIMITS } from '@lumra/config';
import type { PublicGallery, PublicMediaItem } from '@lumra/contracts';
import { selectCover } from '@lumra/domain';
import { Icon } from '@/components/ui';
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
      <div className="relative h-[62svh] max-h-[640px] min-h-[300px] w-full overflow-hidden bg-[var(--color-sunken)]">
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
            className="flex h-full w-full items-center justify-center bg-[var(--color-sunken)] text-[var(--color-ink-muted)]"
          >
            <Icon name="image" size={28} />
          </div>
        )}
      </div>
      <div className="mx-auto flex w-full max-w-[var(--content-max)] flex-wrap items-end justify-between gap-6 px-4 pt-6 pb-5 sm:px-8 sm:pt-12 sm:pb-8">
        <div className="min-w-0">
          <h1 className="lm-hero-title max-w-5xl text-balance break-words">{title}</h1>
          <p className="lm-num mt-2 text-[15px] leading-[22px] text-[var(--color-ink-muted)] sm:text-[17px] sm:leading-[26px]">
            {photoCount === 1 ? '1 photo' : `${photoCount.toLocaleString('en-US')} photos`}
          </p>
        </div>
      </div>
    </header>
  );
}
