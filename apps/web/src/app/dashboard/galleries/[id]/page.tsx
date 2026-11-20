import { notFound, redirect } from 'next/navigation';
import { GalleryEditor } from '@/components/editor/gallery-editor';
import { GalleryUploader } from '@/components/upload';
import { getAuthenticatedUser } from '@/lib/actor';
import { ApiFailure } from '@/lib/api';
import { getDb } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { getGalleryDetail, loadGalleryRows } from '@/server/gallery-editor';
import { optionalMintDeps } from '@/server/public-context';

export const metadata = { title: 'Edit gallery' };
// Per-user, auth-gated: never prerendered or cached.
export const dynamic = 'force-dynamic';

/** Owner gallery editor (T15/T16/T19/T21). Other users' galleries are a plain 404. */
export default async function EditGalleryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Read the gallery while the session is verified (two independent round trips instead of
  // two in sequence). Nothing is used until `getGalleryDetail` has checked ownership below.
  const db = getDb();
  const preloaded = loadGalleryRows(db, id);
  preloaded.catch(() => undefined); // surfaced by getGalleryDetail; no unhandled rejection on redirect
  const user = await getAuthenticatedUser();
  if (!user) redirect(`/auth?returnTo=${encodeURIComponent(`/dashboard/galleries/${id}`)}`);

  let detail;
  try {
    detail = await getGalleryDetail(
      { db, appUrl: serverEnv().NEXT_PUBLIC_APP_URL, media: optionalMintDeps() },
      user.userId,
      id,
      new Date(),
      preloaded,
    );
  } catch (err) {
    if (err instanceof ApiFailure && err.error.code === 'not_found') notFound();
    throw err;
  }
  return (
    <GalleryEditor
      key={detail.id}
      initial={detail}
      uploadSlot={
        <GalleryUploader
          galleryId={detail.id}
          mode="owner"
          signInHref={`/auth?returnTo=${encodeURIComponent(`/dashboard/galleries/${detail.id}`)}`}
        />
      }
    />
  );
}
