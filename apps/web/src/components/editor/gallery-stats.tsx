import type { GalleryAnalytics } from '@lumra/contracts';

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "just now", "5m ago", "2h ago", "3d ago" (coarse on purpose). */
export function formatAgo(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The one-line summary: "142 views · 12 visitors · 23 downloads · last viewed 2h ago". */
export function galleryStatsText(stats: GalleryAnalytics, now: Date): string {
  if (stats.views === 0 && stats.downloads === 0) return 'No views yet';
  const parts = [plural(stats.views, 'view')];
  if (stats.uniqueVisitors > 0) parts.push(plural(stats.uniqueVisitors, 'visitor'));
  parts.push(plural(stats.downloads, 'download'));
  if (stats.lastViewedAt) parts.push(`last viewed ${formatAgo(stats.lastViewedAt, now)}`);
  return parts.join(' · ');
}

/** Muted single line under the gallery title (FR-N02). Renders nothing without stats. */
export function GalleryStatsLine({ stats, now }: { stats: GalleryAnalytics | null; now: Date }) {
  if (!stats) return null;
  return (
    <p data-testid="gallery-stats" className="lm-num text-[13px] text-[var(--color-ink-muted)]">
      {galleryStatsText(stats, now)}
    </p>
  );
}
