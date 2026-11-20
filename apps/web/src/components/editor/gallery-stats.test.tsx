import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GalleryStatsLine, formatAgo, galleryStatsText } from './gallery-stats';

const NOW = new Date('2026-11-20T12:00:00Z');
const stats = {
  views: 142,
  uniqueVisitors: 12,
  itemDownloads: 20,
  archiveDownloads: 3,
  downloads: 23,
  lastViewedAt: '2026-11-20T10:00:00.000Z',
};

describe('galleryStatsText', () => {
  it('is a single muted line', () => {
    expect(galleryStatsText(stats, NOW)).toBe(
      '142 views · 12 visitors · 23 downloads · last viewed 2h ago',
    );
  });
  it('singularizes and omits what is unknown', () => {
    expect(
      galleryStatsText(
        { ...stats, views: 1, uniqueVisitors: 0, downloads: 1, lastViewedAt: null },
        NOW,
      ),
    ).toBe('1 view · 1 download');
  });
  it('says so when nothing has happened', () => {
    expect(
      galleryStatsText(
        { ...stats, views: 0, downloads: 0, uniqueVisitors: 0, lastViewedAt: null },
        NOW,
      ),
    ).toBe('No views yet');
  });
});

describe('formatAgo', () => {
  it('is coarse', () => {
    expect(formatAgo('2026-11-20T11:59:30Z', NOW)).toBe('just now');
    expect(formatAgo('2026-11-20T11:55:00Z', NOW)).toBe('5m ago');
    expect(formatAgo('2026-11-17T12:00:00Z', NOW)).toBe('3d ago');
  });
});

describe('GalleryStatsLine', () => {
  it('renders the summary, or nothing without stats', () => {
    const { rerender, container } = render(<GalleryStatsLine stats={stats} now={NOW} />);
    expect(screen.getByTestId('gallery-stats').textContent).toContain('142 views');
    rerender(<GalleryStatsLine stats={null} now={NOW} />);
    expect(container.textContent).toBe('');
  });
});
