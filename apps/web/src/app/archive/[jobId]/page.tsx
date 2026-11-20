import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { ArchiveProgress } from '@/components/archive/archive-progress';
import { ApiFailure } from '@/lib/api';
import { getDb } from '@/lib/db';
import { GALLERY_SESSION_COOKIE } from '@/lib/gallery-session';
import { clientIp, enforceRateLimit } from '@/lib/rate-limit';
import { GalleryNotice } from '@/app/g/[slug]/gallery-notice';
import { loadArchiveStatus } from '@/server/archive-status';
import { mintDeps } from '@/server/public-context';

export const dynamic = 'force-dynamic';

/**
 * Archive progress / download page (PRD §4 `/archive/[jobId]`, T25). Rendered per request through
 * the same service as `GET /api/v1/public/archives/{jobId}`, so access is re-checked (gallery
 * published + unexpired, password session scoped to this job's paths). Never indexed or cached;
 * no referrer leaks the capability URL.
 */
export const metadata: Metadata = {
  title: 'Download',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default async function ArchivePage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const db = getDb();
  const requestHeaders = await headers();
  try {
    await enforceRateLimit(
      new Request('https://lumra.invalid/', { headers: requestHeaders }),
      'publicArchiveRead',
      { kind: 'ip', ip: clientIp(requestHeaders) },
      { db, challenge: null },
    );
    const status = await loadArchiveStatus(db, jobId, mintDeps(), {
      sessionToken: (await cookies()).get(GALLERY_SESSION_COOKIE)?.value,
    });
    return <ArchiveProgress key={status.jobId} initial={status} />;
  } catch (error) {
    if (!(error instanceof ApiFailure)) throw error;
    switch (error.error.code) {
      case 'not_found':
        return (
          <GalleryNotice
            icon="link"
            title="This download link isn’t available"
            body="It may have been replaced after the gallery changed, or the gallery is no longer shared. Open the gallery link again to start a new download."
          />
        );
      case 'gallery_expired':
        return (
          <GalleryNotice
            title="This gallery has expired"
            body="The link you followed is no longer active. If you still need these photos, ask the person who shared it to extend the link."
          />
        );
      case 'password_required':
        return (
          <GalleryNotice
            icon="lock"
            title="Unlock the gallery first"
            body="This gallery is password protected. Open the gallery link, enter the password, then choose Download all again."
          />
        );
      case 'rate_limited':
        return (
          <GalleryNotice
            title="Too many requests"
            body="Please wait a minute and reload this page."
          />
        );
      default:
        throw error;
    }
  }
}
