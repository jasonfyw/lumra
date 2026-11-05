'use client';

import type { PublicGallery, PublicMediaItem } from '@lumra/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GalleryHero } from './gallery-hero';
import { JustifiedGrid, type JustifiedGridHandle } from './justified-grid';
import { Lightbox } from './lightbox';
import { LumraBadge } from './lumra-badge';

export interface GalleryViewProps {
  gallery: PublicGallery;
  items: readonly PublicMediaItem[];
}

/**
 * Recipient gallery screen (PRD §3 J3): hero, justified grid and lightbox. Purely
 * presentational — the page supplies a parsed `PublicGalleryResponse`.
 *
 * On close, the grid scrolls the current item's row into view and focuses its tile (which is
 * the originating tile unless the viewer navigated inside the lightbox).
 */
export function GalleryView({ gallery, items }: GalleryViewProps) {
  const gridRef = useRef<JustifiedGridHandle>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [revealIndex, setRevealIndex] = useState<number | null>(null);

  const close = useCallback(() => {
    setRevealIndex(openIndex);
    setOpenIndex(null);
  }, [openIndex]);

  // Runs after the lightbox's cleanup has released the scroll lock.
  useEffect(() => {
    if (revealIndex === null) return;
    gridRef.current?.revealItem(revealIndex, { focus: true });
    setRevealIndex(null);
  }, [revealIndex]);

  const open = openIndex !== null;

  return (
    <>
      <div inert={open}>
        <GalleryHero gallery={gallery} items={items} />
        <main className="px-1 pb-10 sm:px-4 lg:px-6">
          {items.length > 0 ? (
            <JustifiedGrid ref={gridRef} items={items} onOpen={setOpenIndex} />
          ) : (
            <p className="px-3 py-16 text-center text-[var(--color-ink-muted)]">
              No photos in this gallery yet.
            </p>
          )}
        </main>
        {gallery.brandingVisible ? (
          <footer className="flex justify-center pb-6">
            <LumraBadge />
          </footer>
        ) : null}
      </div>
      {open ? (
        <Lightbox items={items} index={openIndex} onIndexChange={setOpenIndex} onClose={close} />
      ) : null}
    </>
  );
}
