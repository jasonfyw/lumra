import Link from 'next/link';
import { redirect } from 'next/navigation';
import { decodeKeysetCursor, type GalleryListStatus } from '@lumra/contracts';
import { getAuthenticatedUser } from '@/lib/actor';
import { serverEnv } from '@/lib/env';
import { formatBytes, formatDate } from '@/lib/format';
import { listGalleriesForOwner } from '@/lib/galleries';
import { signOutAction } from '../auth/actions';
import { AppHeader, Icon, Tag, buttonClass } from '@/components/ui';
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
    <div className="flex min-h-dvh flex-col">
      <AppHeader
        actions={
          <>
            <nav aria-label="Account" className="flex items-center gap-1">
              <Link href="/account" className={buttonClass('ghost')}>
                Account
              </Link>
            </nav>
            <form action={signOutAction}>
              <button type="submit" className={buttonClass('ghost')}>
                Sign out
              </button>
            </form>
          </>
        }
      />
      <main className="mx-auto flex w-full max-w-[var(--app-max)] flex-col gap-6 px-4 py-8 sm:px-8 sm:py-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="lm-title-1">Galleries</h1>
          <NewGalleryButton />
        </header>

        {page.items.length === 0 && !cursor ? (
          <section className="lm-panel flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="lm-gate-icon">
              <Icon name="image" size={24} />
            </div>
            <h2 className="lm-title-display-sm">No galleries yet</h2>
            <p className="max-w-sm text-[var(--color-ink-muted)]">
              Create a gallery, add photos and share one link.
            </p>
          </section>
        ) : (
          <section
            aria-label="Your galleries"
            className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-hairline)] bg-[var(--color-surface)]"
          >
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead className="text-[13px] leading-[18px] text-[var(--color-ink-muted)]">
                <tr className="border-b border-[var(--color-hairline)]">
                  <th scope="col" className={th}>
                    Name
                  </th>
                  <th scope="col" className={th}>
                    Status
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Items
                  </th>
                  <th scope="col" className={`${th} text-right`}>
                    Size
                  </th>
                  <th scope="col" className={th}>
                    Created (UTC)
                  </th>
                  <th scope="col" className={th}>
                    Updated (UTC)
                  </th>
                  <th scope="col" className={th}>
                    <span className="sr-only">Link</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((g) => (
                  <tr
                    key={g.id}
                    className="border-b border-[var(--color-hairline)] align-middle transition-colors duration-[var(--duration-fast)] last:border-b-0 hover:bg-[var(--color-paper)]"
                  >
                    <th scope="row" className="px-4 py-1 font-semibold">
                      <Link
                        href={`/dashboard/galleries/${g.id}`}
                        className="inline-flex min-h-11 items-center underline-offset-4 hover:underline"
                      >
                        {g.title}
                      </Link>
                    </th>
                    <td className={td}>
                      <Tag
                        tone={g.status === 'published' ? 'published' : undefined}
                        icon={g.status === 'expired' ? 'clock' : undefined}
                        dot={g.status !== 'expired'}
                      >
                        {STATUS_LABEL[g.status]}
                      </Tag>
                    </td>
                    <td className={`${td} text-right`}>{g.itemCount}</td>
                    <td className={`${td} text-right`}>{formatBytes(g.storedBytes)}</td>
                    <td className={`${td} text-[var(--color-ink-muted)]`}>
                      {formatDate(g.createdAt)}
                    </td>
                    <td className={`${td} text-[var(--color-ink-muted)]`}>
                      {formatDate(g.updatedAt)}
                    </td>
                    <td className={`${td} text-right`}>
                      {g.status === 'draft' ? (
                        <span className="text-[13px] text-[var(--color-ink-muted)]">
                          Not published
                        </span>
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

        <nav aria-label="Pagination" className="flex gap-2">
          {cursor && (
            <Link href="/dashboard" className={buttonClass('secondary', 'sm')}>
              <Icon name="chevron-left" size={16} />
              Newest
            </Link>
          )}
          {page.nextCursor && (
            <Link
              href={`/dashboard?cursor=${encodeURIComponent(page.nextCursor)}`}
              className={buttonClass('secondary', 'sm')}
            >
              Older galleries
              <Icon name="chevron-right" size={16} />
            </Link>
          )}
        </nav>
      </main>
    </div>
  );
}

const th = 'px-4 py-3 font-medium whitespace-nowrap';
const td = 'lm-num px-4 py-1 whitespace-nowrap';
