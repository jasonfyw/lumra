import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorMediaItem, GalleryDetail } from '@lumra/contracts';
import { localInputToUtcIso, utcIsoToLocalInput } from '@/lib/editor-client';
import { GalleryEditor } from './gallery-editor';
import { MediaGrid, moveItem } from './media-grid';
import { qrMatrix, ShareSheet } from './share-sheet';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function item(n: number, status: EditorMediaItem['status'] = 'ready'): EditorMediaItem {
  return {
    id: uuid(n),
    status,
    filename: `IMG_${n}.jpg`,
    mime: 'image/jpeg',
    byteSize: 1000,
    width: 4000,
    height: 3000,
    sortKey: `a${n}`,
    failureCode: null,
    createdAt: '2026-11-05T10:00:00.000Z',
    thumbnailUrl: null,
  };
}

function detail(overrides: Partial<GalleryDetail> = {}): GalleryDetail {
  const items = [item(1), item(2), item(3, 'failed')];
  return {
    id: uuid(99),
    slug: 'AbCdEfGh1234',
    title: 'Trip',
    status: 'draft',
    accessState: 'draft',
    expiresAt: null,
    publishedAt: null,
    hasPassword: false,
    coverMediaId: null,
    effectiveCoverMediaId: uuid(1),
    shareUrl: null,
    itemCount: items.length,
    contentVersion: 1,
    accessVersion: 1,
    createdAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:00:00.000Z',
    items,
    ...overrides,
  };
}

type FetchCall = { url: string; method: string; body: unknown };
let calls: FetchCall[];

function mockFetch(respond: (call: FetchCall) => unknown) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = {
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      return new Response(JSON.stringify({ data: respond(call), error: null, requestId: 'r' }));
    }),
  );
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('moveItem', () => {
  it('moves and ignores out-of-range targets', () => {
    expect(moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(moveItem([1, 2, 3], 0, 3)).toEqual([1, 2, 3]);
  });
});

describe('MediaGrid reorder buttons', () => {
  it('moves earlier/later and disables at the ends', async () => {
    const onMove = vi.fn();
    render(
      <MediaGrid
        items={[item(1), item(2), item(3)]}
        coverMediaId={null}
        effectiveCoverMediaId={null}
        onMove={onMove}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Move IMG_1.jpg earlier' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move IMG_3.jpg later' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Move IMG_2.jpg earlier' }));
    expect(onMove).toHaveBeenCalledWith(1, 0);
    await userEvent.click(screen.getByRole('button', { name: 'Move IMG_2.jpg later' }));
    expect(onMove).toHaveBeenCalledWith(1, 2);
  });

  it('shows creator statuses, including recoverable failures', () => {
    render(
      <MediaGrid
        items={[item(1, 'processing'), item(2, 'failed')]}
        coverMediaId={null}
        effectiveCoverMediaId={null}
        onMove={vi.fn()}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.getByText('Unavailable — re-upload or delete')).toBeInTheDocument();
  });

  it('drags with a mouse via the handle', () => {
    const onMove = vi.fn();
    render(
      <MediaGrid
        items={[item(1), item(2), item(3)]}
        coverMediaId={null}
        effectiveCoverMediaId={null}
        onMove={onMove}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const tiles = screen.getAllByRole('listitem');
    document.elementFromPoint = vi.fn(() => tiles[2]!) as typeof document.elementFromPoint;
    const handle = screen.getByRole('button', { name: 'Drag to reorder IMG_1.jpg' });
    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      clientX: 0,
      clientY: 0,
      pointerType: 'mouse',
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 50, clientY: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 50, clientY: 0, pointerType: 'mouse' });
    expect(onMove).toHaveBeenCalledWith(0, 2);
  });
});

describe('GalleryEditor', () => {
  it('reorders with the accessible buttons, saves the full order and announces it', async () => {
    mockFetch(() => ({ contentVersion: 2, updated: 1, rebalanced: false }));
    render(<GalleryEditor initial={detail()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Move IMG_3.jpg earlier' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `/api/v1/galleries/${uuid(99)}/media/order`,
      body: { orderedIds: [uuid(1), uuid(3), uuid(2)] },
    });
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Moved IMG_3.jpg to position 2 of 3.'),
    );
    const names = screen.getAllByRole('listitem').map((li) => li.getAttribute('aria-label'));
    expect(names[1]).toMatch(/^IMG_3\.jpg/);
  });

  it('deleting a photo needs confirmation; cancel sends nothing', async () => {
    mockFetch((call) =>
      call.method === 'DELETE'
        ? { mediaId: uuid(2), status: 'deleting', contentVersion: 2, coverMediaId: null }
        : detail({ items: [item(1), item(3, 'failed')], itemCount: 2 }),
    );
    render(<GalleryEditor initial={detail()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete IMG_2.jpg' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this photo?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Delete IMG_2.jpg' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete photo' }));
    await waitFor(() => expect(screen.queryByText('IMG_2.jpg')).not.toBeInTheDocument());
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      url: `/api/v1/galleries/${uuid(99)}/media/${uuid(2)}`,
    });
  });

  it('gallery deletion is gated by an irreversible-confirmation dialog', async () => {
    mockFetch(() => ({ id: uuid(99), status: 'deleted', deletedAt: '2026-11-05T10:00:00.000Z' }));
    render(<GalleryEditor initial={detail()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete gallery…' }));
    const dialog = screen.getByRole('dialog', { name: /Delete “Trip” permanently\?/ });
    expect(dialog).toHaveTextContent('can’t be undone');
    const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Type “delete”/), 'delete');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `/api/v1/galleries/${uuid(99)}` });
  });

  it('renames inline', async () => {
    mockFetch((call) => detail({ title: (call.body as { title: string }).title }));
    render(<GalleryEditor initial={detail()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Gallery title');
    await userEvent.clear(input);
    await userEvent.type(input, 'Wedding{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Wedding' })).toBeInTheDocument(),
    );
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { title: 'Wedding' } });
  });

  it('publishes with UTC-converted expiry and shows the share sheet', async () => {
    const shareUrl = 'https://lumra.test/g/AbCdEfGh1234';
    mockFetch((call) =>
      call.url.endsWith('/publish')
        ? {
            slug: 'AbCdEfGh1234',
            shareUrl,
            publishedAt: '2026-11-05T10:00:00.000Z',
            expiresAt: null,
            hasPassword: false,
            alreadyPublished: false,
          }
        : detail({ status: 'published', accessState: 'published', shareUrl }),
    );
    render(<GalleryEditor initial={detail()} />);
    fireEvent.change(screen.getByLabelText(/Link expires/), {
      target: { value: '2030-01-02T03:04' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument(),
    );
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { expiresAt: new Date('2030-01-02T03:04').toISOString() },
    });
  });
});

describe('ShareSheet', () => {
  const url = 'https://lumra.test/g/AbCdEfGh1234';

  it('renders a QR code for the share URL', () => {
    render(<ShareSheet url={url} title="Trip" />);
    const qr = screen.getByRole('img', { name: `QR code for ${url}` });
    expect(qr.getAttribute('data-qr-url')).toBe(url);
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d/);
    const matrix = qrMatrix(url);
    expect(matrix.length).toBeGreaterThanOrEqual(21);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
    // Finder pattern corner is dark.
    expect(matrix[0]![0]).toBe(true);
  });

  it('copies with the Clipboard API', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ShareSheet url={url} title="Trip" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(url);
    expect(screen.getByRole('status')).toHaveTextContent('Link copied.');
  });

  it('falls back to selecting the link when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    document.execCommand = vi.fn(() => false);
    render(<ShareSheet url={url} title="Trip" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(screen.getByRole('status')).toHaveTextContent('Link selected');
    expect(screen.getByLabelText('Share link')).toHaveFocus();
  });

  it('hides native share when unsupported; uses it when present and falls back to copy', async () => {
    const { unmount } = render(<ShareSheet url={url} title="Trip" />);
    expect(screen.queryByRole('button', { name: 'Share…' })).not.toBeInTheDocument();
    unmount();

    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    render(<ShareSheet url={url} title="Trip" />);
    await userEvent.click(screen.getByRole('button', { name: 'Share…' }));
    expect(share).toHaveBeenCalledWith({ title: 'Trip', url });
    expect(writeText).not.toHaveBeenCalled();

    // User cancelled the native sheet: nothing else happens.
    share.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'AbortError' }));
    await userEvent.click(screen.getByRole('button', { name: 'Share…' }));
    expect(writeText).not.toHaveBeenCalled();

    // Share failed for another reason: copy instead.
    share.mockRejectedValueOnce(new Error('NotAllowed'));
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Share…' }));
    });
    expect(writeText).toHaveBeenCalledWith(url);
    Reflect.deleteProperty(navigator, 'share');
  });
});

describe('expiry conversion', () => {
  it('converts local datetime-local values to UTC ISO and back', () => {
    expect(localInputToUtcIso('')).toBeNull();
    const iso = localInputToUtcIso('2030-01-02T03:04')!;
    expect(iso).toMatch(/Z$/);
    expect(new Date(iso).getTime()).toBe(new Date(2030, 0, 2, 3, 4).getTime());
    expect(utcIsoToLocalInput(iso)).toBe('2030-01-02T03:04');
    expect(utcIsoToLocalInput(null)).toBe('');
  });
});
