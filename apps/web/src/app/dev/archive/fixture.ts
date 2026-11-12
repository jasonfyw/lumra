import { archiveStatusResponseSchema, type ArchiveStatusResponse } from '@lumra/contracts';

export const ARCHIVE_FIXTURE_STATES = [
  'preparing',
  'processing',
  'ready',
  'failed',
  'expired',
] as const;
export type ArchiveFixtureState = (typeof ARCHIVE_FIXTURE_STATES)[number];

/** Contract-valid archive status for the dev fixture page and component tests. */
export function makeArchiveFixture(
  state: ArchiveFixtureState,
  partCount: number,
  now = new Date(),
): ArchiveStatusResponse {
  const perPart = 103;
  const parts = Array.from({ length: partCount }, (_, i) => {
    const items = i === partCount - 1 && partCount > 1 ? 40 : perPart;
    const sourceBytes = items * 19_400_000;
    return {
      partNo: i + 1,
      itemCount: items,
      sourceBytes,
      byteSize: state === 'ready' ? sourceBytes + items * 120 : null,
      ready: state === 'ready',
      filename:
        partCount > 1 ? `Autumn wedding (part ${i + 1} of ${partCount}).zip` : 'Autumn wedding.zip',
      ...(state === 'ready' ? { downloadUrl: `/dev/placeholder/1/1?part=${i + 1}` } : {}),
    };
  });
  const itemCount = parts.reduce((s, p) => s + p.itemCount, 0);
  return archiveStatusResponseSchema.parse({
    jobId: '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    status: state,
    progressPct: state === 'processing' ? 46 : state === 'ready' ? 100 : 0,
    gallery: { slug: 'dev-fixture', title: 'Autumn wedding' },
    itemCount,
    totalBytes: parts.reduce((s, p) => s + p.sourceBytes, 0),
    partsExpected: partCount,
    parts,
    expiresAt: state === 'ready' ? new Date(now.getTime() + 23.5 * 3_600_000).toISOString() : null,
    ...(state === 'ready' ? { urlsExpireAt: new Date(now.getTime() + 300_000).toISOString() } : {}),
    failureCode: state === 'failed' ? 'build_failed' : null,
    createdAt: now.toISOString(),
  });
}
