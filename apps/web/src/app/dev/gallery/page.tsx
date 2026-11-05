import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { publicGalleryResponseSchema } from '@lumra/contracts';
import { GalleryView } from '@/components/gallery';
import { makeGalleryFixture } from './fixture';

/**
 * Dev-only fixture for the recipient gallery UI (T17/T18): `/dev/gallery?n=2000`.
 * Optional `cover=<index>` sets the cover override; `branding=0` hides the badge.
 * Returns 404 in production builds and is not linked from anywhere.
 */
export const metadata: Metadata = {
  title: 'Gallery fixture',
  robots: { index: false, follow: false },
};

const DEFAULT_COUNT = 120;

type SearchParams = Record<string, string | string[] | undefined>;

function intParam(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !/^\d{1,5}$/.test(raw)) return undefined;
  return Number(raw);
}

export default async function DevGalleryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const params = await searchParams;
  const fixture = makeGalleryFixture(intParam(params.n) ?? DEFAULT_COUNT, {
    coverIndex: intParam(params.cover),
    branding: params.branding !== '0',
  });
  // Validate against the public contract so the fixture can't drift from the API shape.
  const { gallery, items } = publicGalleryResponseSchema.parse(fixture);
  return <GalleryView gallery={gallery} items={items} />;
}
