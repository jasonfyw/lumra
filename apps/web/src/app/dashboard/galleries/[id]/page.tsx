import { notFound, redirect } from 'next/navigation';
import { GalleryEditor } from '@/components/editor/gallery-editor';
import { getAuthenticatedUser } from '@/lib/actor';
import { ApiFailure } from '@/lib/api';
import { getDb } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { getGalleryDetail } from '@/server/gallery-editor';

export const metadata = { title: 'Edit gallery' };
// Per-user, auth-gated: never prerendered or cached.
export const dynamic = 'force-dynamic';

/** Owner gallery editor (T15/T16/T19/T21). Other users' galleries are a plain 404. */
export default async function EditGalleryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect(`/auth?returnTo=${encodeURIComponent(`/dashboard/galleries/${id}`)}`);

  let detail;
  try {
    detail = await getGalleryDetail(
      { db: getDb(), appUrl: serverEnv().NEXT_PUBLIC_APP_URL },
      user.userId,
      id,
    );
  } catch (err) {
    if (err instanceof ApiFailure && err.error.code === 'not_found') notFound();
    throw err;
  }
  return <GalleryEditor key={detail.id} initial={detail} />;
}
