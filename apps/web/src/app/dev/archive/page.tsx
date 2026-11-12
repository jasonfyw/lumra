import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArchiveProgress } from '@/components/archive/archive-progress';
import { ARCHIVE_FIXTURE_STATES, makeArchiveFixture } from './fixture';

/**
 * Dev-only fixture for the archive progress page (T25): `/dev/archive?state=processing&parts=4`.
 * `state` is one of preparing | processing | ready | failed | expired. Rendered with polling off.
 * Returns 404 in production builds and is not linked from anywhere.
 */
export const metadata: Metadata = {
  title: 'Archive fixture',
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function DevArchivePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const params = await searchParams;
  const raw = first(params.state);
  const state = ARCHIVE_FIXTURE_STATES.find((s) => s === raw) ?? 'processing';
  const parts = Math.min(Math.max(Number(first(params.parts)) || 1, 1), 8);
  return <ArchiveProgress initial={makeArchiveFixture(state, parts)} live={false} />;
}
