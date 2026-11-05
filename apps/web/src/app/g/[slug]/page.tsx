import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { PublicGallery } from '@/components/gallery';
import { ApiFailure } from '@/lib/api';
import { getDb } from '@/lib/db';
import { GALLERY_SESSION_COOKIE } from '@/lib/gallery-session';
import { clientIp, enforceRateLimit } from '@/lib/rate-limit';
import { mintDeps } from '@/server/public-context';
import { loadPublicGallery } from '@/server/public-gallery';
import { GalleryNotice } from './gallery-notice';
import { PasswordGate } from './password-gate';

export const dynamic = 'force-dynamic';

/**
 * Recipient gallery (PRD §3 J3/J4, §4 `/g/[slug]`; T16/T19). Rendered per request (never
 * cached: password sessions and short-lived URLs are per viewer) through the same service as
 * `GET /api/v1/public/galleries/{slug}`. Not indexed by search engines; the generic title never
 * reveals a protected gallery's name.
 */
export const metadata: Metadata = {
  title: 'Gallery',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default async function GalleryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDb();
  const requestHeaders = await headers();

  try {
    await enforceRateLimit(
      new Request('https://lumra.invalid/', { headers: requestHeaders }),
      'publicGalleryRead',
      { kind: 'ip', ip: clientIp(requestHeaders) },
      { db, challenge: null },
    );
    const data = await loadPublicGallery(db, slug, mintDeps(), {
      sessionToken: (await cookies()).get(GALLERY_SESSION_COOKIE)?.value,
    });
    if ('passwordRequired' in data) return <PasswordGate slug={slug} />;
    return <PublicGallery key={data.gallery.id} slug={slug} initial={data} />;
  } catch (error) {
    if (!(error instanceof ApiFailure)) throw error;
    switch (error.error.code) {
      case 'not_found':
        notFound();
      // eslint-disable-next-line no-fallthrough -- notFound() throws
      case 'gallery_expired':
        return (
          <GalleryNotice
            title="This gallery has expired"
            body="The link you followed is no longer active. If you still need these photos, ask the person who shared it to extend the link."
          />
        );
      case 'rate_limited':
        return (
          <GalleryNotice
            title="Too many requests"
            body="This gallery is getting a lot of requests from your network. Please wait a minute and reload the page."
          />
        );
      default:
        throw error;
    }
  }
}
