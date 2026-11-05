import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeGalleryFixture } from '@/app/dev/gallery/fixture';
import { GalleryHero } from './gallery-hero';
import { GalleryView } from './gallery-view';

describe('GalleryHero', () => {
  it('uses the first ready photo when there is no override', () => {
    const { gallery, items } = makeGalleryFixture(10);
    // Fixture item 0 is pending, so the hero falls back to the next ready photo.
    const firstReady = items.find((item) => item.status === 'ready')!;
    render(<GalleryHero gallery={gallery} items={items} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(gallery.title);
    expect(screen.getByRole('img', { name: firstReady.filename })).toBeInTheDocument();
  });

  it('honours a ready cover override', () => {
    const { gallery, items } = makeGalleryFixture(10, { coverIndex: 6 });
    render(<GalleryHero gallery={gallery} items={items} />);
    expect(screen.getByRole('img', { name: items[6]!.filename })).toBeInTheDocument();
  });

  it('shows a neutral placeholder until a ready cover exists', () => {
    const { gallery, items } = makeGalleryFixture(1); // only the pending item
    render(<GalleryHero gallery={{ ...gallery, title: '  ' }} items={items} />);
    expect(screen.getByRole('img', { name: 'Cover photo not available yet' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Untitled gallery');
  });
});

describe('GalleryView', () => {
  it('opens the lightbox from a tile with Enter and returns focus to the current tile', async () => {
    const user = userEvent.setup();
    const { gallery, items } = makeGalleryFixture(40);
    const { container } = render(<GalleryView gallery={gallery} items={items} />);
    const tile = container.querySelector<HTMLElement>('[data-index="4"]')!;
    tile.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(`5 of ${items.length}`)).toBeInTheDocument();

    await user.keyboard('{ArrowRight}{ArrowRight}{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(container.querySelector('[data-index="6"]')).toHaveFocus());
  });

  it('returns focus to the originating tile when closed without navigating', async () => {
    const user = userEvent.setup();
    const { gallery, items } = makeGalleryFixture(40);
    const { container } = render(<GalleryView gallery={gallery} items={items} />);
    const tile = container.querySelector<HTMLElement>('[data-index="9"]')!;
    await user.click(tile);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(tile).toHaveFocus());
  });

  it('makes the page behind the open lightbox inert', async () => {
    const user = userEvent.setup();
    const { gallery, items } = makeGalleryFixture(10);
    const { container } = render(<GalleryView gallery={gallery} items={items} />);
    await user.click(container.querySelector<HTMLElement>('[data-index="2"]')!);
    expect(screen.getByRole('heading', { level: 1 }).closest('[inert]')).not.toBeNull();
  });

  it('shows the Lumra badge only when branding is visible', () => {
    const branded = makeGalleryFixture(3);
    const { unmount } = render(<GalleryView {...branded} />);
    expect(screen.getByRole('link', { name: 'Made with Lumra' })).toBeInTheDocument();
    unmount();
    const plain = makeGalleryFixture(3, { branding: false });
    render(<GalleryView {...plain} />);
    expect(screen.queryByRole('link', { name: 'Made with Lumra' })).not.toBeInTheDocument();
  });
});
