import type { PublicMediaItem } from '@lumra/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fixtureId, makeGalleryFixture } from '@/app/dev/gallery/fixture';
import { JustifiedGrid } from './justified-grid';

function tiles(container: HTMLElement) {
  return container.querySelectorAll('[data-gallery-tile]');
}

describe('JustifiedGrid', () => {
  it('renders a bounded number of tiles for 2,000 items', () => {
    const { items } = makeGalleryFixture(2_000);
    const { container } = render(<JustifiedGrid items={items} onOpen={() => {}} />);
    const count = tiles(container).length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(200);
    // The spacer still spans the whole layout so the scrollbar reflects all 2,000 items.
    const list = screen.getByRole('list', { name: 'Photos' });
    expect(parseFloat(list.style.height)).toBeGreaterThan(50_000);
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('aria-setsize', '2000');
  });

  it('labels placeholders accessibly and never shows internal errors', () => {
    const items: PublicMediaItem[] = [
      {
        id: fixtureId(1),
        status: 'pending',
        width: null,
        height: null,
        uploadOrder: 0,
        filename: 'a.jpg',
        variants: [],
      },
      {
        id: fixtureId(2),
        status: 'unavailable',
        width: 300,
        height: 200,
        uploadOrder: 1,
        filename: 'b.jpg',
        variants: [],
      },
    ];
    render(<JustifiedGrid items={items} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Photo still processing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Photo unavailable' })).toBeInTheDocument();
    expect(screen.queryByText(/error|failed/i)).not.toBeInTheDocument();
  });

  it('renders ready tiles as lazy responsive images with explicit sizes', () => {
    const { items } = makeGalleryFixture(30);
    const { container } = render(<JustifiedGrid items={items} onOpen={() => {}} />);
    const index = items.findIndex((item) => item.status === 'ready');
    const tile = container.querySelector<HTMLElement>(`[data-index="${index}"]`)!;
    expect(tile).toHaveAccessibleName(`Open ${items[index]!.filename}`);
    const img = tile.querySelector('img')!;
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img.getAttribute('srcset')).toMatch(/ 320w, .* 640w/);
    expect(img.getAttribute('sizes')).toMatch(/^\d+px$/);
    const li = tile.parentElement!;
    expect(img).toHaveAttribute('width', String(parseInt(li.style.width, 10)));
    expect(img).toHaveAttribute('height', String(parseInt(li.style.height, 10)));
  });

  it('keeps tiles in item order and opens the activated index', () => {
    const { items } = makeGalleryFixture(40);
    const onOpen = vi.fn();
    const { container } = render(<JustifiedGrid items={items} onOpen={onOpen} />);
    const indices = [...tiles(container)].map((el) => Number((el as HTMLElement).dataset.index));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    fireEvent.click(container.querySelector('[data-index="5"]')!);
    expect(onOpen).toHaveBeenCalledWith(5);
  });
});
