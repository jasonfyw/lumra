import { getAuthenticatedUser } from '@/lib/actor';
import { NewGallery } from './new-gallery';

export const metadata = { title: 'New gallery' };
// Per-visitor: guest vs signed-in decides which draft/gallery this screen creates.
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/new` (PRD §4, J1, T14): instant draft, upload zone straight away, optional title and the
 * Publish CTA. No modal onboarding. Guests get a guest draft; signed-in creators get a new
 * account gallery (or `?gallery=` — e.g. the draft they just claimed by signing in).
 */
export default async function NewGalleryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const user = await getAuthenticatedUser().catch(() => null);
  const gallery =
    typeof params.gallery === 'string' && UUID.test(params.gallery) ? params.gallery : null;
  return <NewGallery signedIn={user !== null} initialGalleryId={user ? gallery : null} />;
}
