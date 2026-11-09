import type { Metadata } from 'next';
import { GalleryNotice } from './gallery-notice';

export const metadata: Metadata = {
  title: 'Gallery not found',
  robots: { index: false, follow: false },
};

/** Unknown, draft and deleted galleries look identical (concealed existence, PRD §10). */
export default function GalleryNotFound() {
  return (
    <GalleryNotice
      icon="image"
      title="Gallery not found"
      body="This link doesn’t point to an available gallery. Check that you copied the whole link, or ask the person who shared it for a new one."
    />
  );
}
