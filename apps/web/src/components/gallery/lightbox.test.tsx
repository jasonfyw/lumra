import type { PublicMediaItem } from '@lumra/contracts';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeGalleryFixture } from '@/app/dev/gallery/fixture';
import { Lightbox, SWIPE_THRESHOLD_PX } from './lightbox';

const { items } = makeGalleryFixture(12);
const readyIndex = items.findIndex((item) => item.status === 'ready');
const pendingIndex = items.findIndex((item) => item.status === 'pending');

function Controlled({
  initial,
  list = items,
  onClose = () => {},
}: {
  initial: number;
  list?: readonly PublicMediaItem[];
  onClose?: () => void;
}) {
  const [index, setIndex] = useState(initial);
  return <Lightbox items={list} index={index} onIndexChange={setIndex} onClose={onClose} />;
}

describe('Lightbox', () => {
  it('is a labelled modal dialog with a position counter', () => {
    render(<Controlled initial={readyIndex} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(items[readyIndex]!.filename);
    expect(screen.getByText(`${readyIndex + 1} of ${items.length}`)).toBeInTheDocument();
  });

  it('navigates with Left/Right and stops at the ends', async () => {
    const user = userEvent.setup();
    render(<Controlled initial={0} />);
    expect(screen.getByText(`1 of ${items.length}`)).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByText(`1 of ${items.length}`)).toBeInTheDocument();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByText(`3 of ${items.length}`)).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByText(`2 of ${items.length}`)).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Controlled initial={1} onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the dialog and traps Tab inside it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">outside</button>
        <Controlled initial={readyIndex} />
      </>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 8; i++) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('restores focus to the opener when closed', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            opener
          </button>
          {open ? <Controlled initial={readyIndex} onClose={() => setOpen(false)} /> : null}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('offers the original download only for ready items', () => {
    const { unmount } = render(<Controlled initial={readyIndex} />);
    const link = screen.getByRole('link', { name: 'Download original' });
    expect(link).toHaveAttribute('href', items[readyIndex]!.downloadUrl);
    expect(link).toHaveAttribute('download');
    unmount();

    render(<Controlled initial={pendingIndex} />);
    expect(screen.getByRole('button', { name: 'Download original' })).toBeDisabled();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Photo still processing');
    expect(screen.getByText(/still processing. Check back soon/i)).toBeInTheDocument();
  });

  it('has ≥44 px previous/next/close controls that navigate', () => {
    render(<Controlled initial={2} />);
    for (const name of ['Close', 'Previous photo', 'Next photo']) {
      expect(screen.getByRole('button', { name })).toHaveClass('size-12'); // 48 × 48 CSS px
    }
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
    expect(screen.getByText(`4 of ${items.length}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }));
    expect(screen.getByText(`3 of ${items.length}`)).toBeInTheDocument();
  });

  it('navigates on horizontal swipes past the threshold only', () => {
    render(<Controlled initial={2} />);
    const stage = screen.getByTestId('lightbox-stage');
    const swipe = (dx: number, dy = 0) => {
      act(() => {
        fireEvent.pointerDown(stage, { clientX: 200, clientY: 300, pointerId: 1, isPrimary: true });
        fireEvent.pointerUp(stage, {
          clientX: 200 + dx,
          clientY: 300 + dy,
          pointerId: 1,
          isPrimary: true,
        });
      });
    };
    swipe(-(SWIPE_THRESHOLD_PX + 10));
    expect(screen.getByText(`4 of ${items.length}`)).toBeInTheDocument();
    swipe(SWIPE_THRESHOLD_PX + 10);
    expect(screen.getByText(`3 of ${items.length}`)).toBeInTheDocument();
    swipe(-(SWIPE_THRESHOLD_PX - 10));
    swipe(-80, 200); // mostly vertical
    expect(screen.getByText(`3 of ${items.length}`)).toBeInTheDocument();
  });

  it('locks background scroll while open', () => {
    const { unmount } = render(<Controlled initial={0} />);
    expect(document.documentElement.style.overflow).toBe('hidden');
    unmount();
    expect(document.documentElement.style.overflow).toBe('');
  });
});
