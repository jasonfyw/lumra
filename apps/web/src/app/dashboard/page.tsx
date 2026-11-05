import Link from 'next/link';
import { redirect } from 'next/navigation';
import { decodeKeysetCursor, type GalleryListStatus } from '@lumra/contracts';
import { getAuthenticatedUser } from '@/lib/actor';
import { serverEnv } from '@/lib/env';
import { formatBytes, formatDate } from '@/lib/format';
import { listGalleriesForOwner } from '@/lib/galleries';
import { signOutAction } from '../auth/actions';
import { CopyLinkButton, NewGalleryButton } from './dashboard-actions';

export const metadata = { title: 'Galleries' };
// Per-user, auth-gated: never prerendered or cached.
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const STATUS_LABEL: Record<GalleryListStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  expired: 'Expired',
};

type SearchParams = Record<string, string | string[] | undefined>;

/** Creator dashboard (T08, J2, FR-N01): text list sorted by last modified, keyset-paginated. */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/auth?returnTo=%2Fdashboard');

  const params = await searchParams;
  const rawCursor = typeof params.cursor === 'string' ? params.cursor : null;
  const cursor = rawCursor ? decodeKeysetCursor(rawCursor) : null;
  const page = await listGalleriesForOwner(user.userId, { limit: PAGE_SIZE, cursor });
  const appUrl = serverEnv().NEXT_PUBLIC_APP_URL;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight">
          Galleries
        </h1>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/account"
            className="min-h-11 content-center underline-offset-4 hover:underline"
          >
            Account
          </Link>
          <form action={signOutAction}>
            <button type="submit" className="min-h-11 underline-offset-4 hover:underline">
              Sign out
            </button>
          </form>
          <NewGalleryButton />
        </div>
      </header>

      {page.items.length === 0 && !cursor ? (
        <section className="flex flex-col items-start gap-3 rounded-[var(--radius-control)] border border-[var(--color-line)] p-8">
          <h2 className="text-xl font-semibold">No galleries yet</h2>
          <p className="text-[var(--color-ink-muted)]">
            Create a gallery, add photos and share one link.
          </p>
        </section>
      ) : (
        <section aria-label="Your galleries" className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead className="text-sm text-[var(--color-ink-muted)]">
              <tr className="border-b border-[var(--color-line)]">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Name
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Items
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Size
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Created (UTC)
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Updated (UTC)
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Link</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((g) => (
                <tr key={g.id} className="border-b border-[var(--color-line)] align-middle">
                  <th scope="row" className="py-2 pr-4 font-medium">
                    <Link
                      href={`/dashboard/galleries/${g.id}`}
                      className="inline-flex min-h-11 items-center underline-offset-4 hover:underline"
                    >
                      {g.title}
                    </Link>
                  </th>
                  <td className="py-2 pr-4">{STATUS_LABEL[g.status]}</td>
                  <td className="py-2 pr-4 tabular-nums">{g.itemCount}</td>
                  <td className="py-2 pr-4 tabular-nums">{formatBytes(g.storedBytes)}</td>
                  <td className="py-2 pr-4">{formatDate(g.createdAt)}</td>
                  <td className="py-2 pr-4">{formatDate(g.updatedAt)}</td>
                  <td className="py-2">
                    {g.status === 'draft' ? (
                      <span className="text-sm text-[var(--color-ink-muted)]">Not published</span>
                    ) : (
                      <CopyLinkButton
                        url={new URL(`/g/${g.slug}`, appUrl).toString()}
                        label={g.title}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <nav aria-label="Pagination" className="flex gap-6">
        {cursor && (
          <Link
            href="/dashboard"
            className="min-h-11 content-center underline-offset-4 hover:underline"
          >
            Newest
          </Link>
        )}
        {page.nextCursor && (
          <Link
            href={`/dashboard?cursor=${encodeURIComponent(page.nextCursor)}`}
            className="min-h-11 content-center underline-offset-4 hover:underline"
          >
            Older galleries
          </Link>
        )}
      </nav>
    </main>
  );
}
