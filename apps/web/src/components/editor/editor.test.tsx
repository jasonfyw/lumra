import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useContext, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorMediaItem, GalleryDetail } from '@lumra/contracts';
import { localInputToUtcIso, utcIsoToLocalInput } from '@/lib/editor-client';
import { GalleryEditor } from './gallery-editor';
import { MediaGrid, moveItem } from './media-grid';
import { mergeThumbnails, tilePhase, useLocalPreviews, type LocalUpload } from './thumbnails';
import { UploadBridgeContext } from '@/components/upload';
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

  it('shows thumbnails for ready photos, overlays for pending and an error for failed', () => {
    const ready = { ...item(1), thumbnailUrl: 'https://media.test/m/t1' };
    render(
      <MediaGrid
        items={[ready, item(2, 'processing'), item(3, 'failed'), item(4, 'uploading')]}
        coverMediaId={null}
        effectiveCoverMediaId={null}
        onMove={vi.fn()}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const [readyTile, processingTile, failedTile, uploadingTile] = screen
      .getAllByRole('listitem')
      .map((li) => within(li));

    // Ready: just the picture, no status text or badge (the accessible name keeps the status).
    const img = readyTile!.getByTestId('tile-thumbnail');
    expect(img).toHaveAttribute('src', 'https://media.test/m/t1');
    expect(img).toHaveAttribute('alt', '');
    expect(readyTile!.queryByText('Ready')).toBeNull();
    expect(readyTile!.queryByTestId('tile-pending')).toBeNull();
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute(
      'aria-label',
      'IMG_1.jpg, Ready, position 1 of 4',
    );

    // Processing: no spinner chip, just a small corner dot with a visually hidden label.
    expect(processingTile!.getByTestId('tile-finishing')).toHaveTextContent('Processing');
    expect(processingTile!.getByText('Processing')).toHaveClass('sr-only');
    expect(processingTile!.queryByTestId('tile-pending')).toBeNull();
    expect(processingTile!.queryByTestId('tile-thumbnail')).toBeNull();
    expect(uploadingTile!.getByTestId('tile-pending')).toHaveTextContent('Uploading');

    // Failed: icon + text + tooltip, not colour alone.
    const failed = failedTile!.getByTestId('tile-failed');
    expect(failed).toHaveTextContent('Unavailable');
    expect(failed).toHaveTextContent('Re-upload or delete');
    expect(failed).toHaveAttribute('title', 'Unavailable — re-upload or delete');
    expect(failed.querySelector('svg')).not.toBeNull();
  });

  it('shows the local preview undimmed with a subtle indicator while processing', () => {
    render(
      <MediaGrid
        items={[item(1, 'processing')]}
        coverMediaId={null}
        effectiveCoverMediaId={null}
        localPreviews={new Map([[uuid(1), 'blob:local-1']])}
        onMove={vi.fn()}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const img = screen.getByTestId('tile-thumbnail');
    expect(img).toHaveAttribute('src', 'blob:local-1');
    expect(img).not.toHaveClass('lm-tile-pending-img');
    expect(screen.getByTestId('tile-finishing')).toHaveTextContent('Processing');
    expect(screen.queryByTestId('tile-pending')).toBeNull();
  });

  it('shows a thin progress bar over the dimmed local preview while uploading', () => {
    render(
      <MediaGrid
        items={[item(1, 'uploading')]}
        coverMediaId={null}
        effectiveCoverMediaId={null}
        localPreviews={new Map([[uuid(1), 'blob:local-1']])}
        localUploads={new Map([[uuid(1), { state: 'uploading', percent: 40, errorCode: null }]])}
        onMove={vi.fn()}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByTestId('tile-thumbnail')).toHaveClass('lm-tile-pending-img');
    expect(screen.getByTestId('tile-progress')).toHaveAttribute('aria-valuenow', '40');
    expect(screen.queryByTestId('tile-pending')).toBeNull();
  });

  it('shows an alert badge, never a spinner, for an interrupted upload', () => {
    render(
      <MediaGrid
        items={[item(1, 'uploading')]}
        coverMediaId={null}
        effectiveCoverMediaId={null}
        localUploads={new Map([[uuid(1), { state: 'failed', percent: 10, errorCode: 'network' }]])}
        onMove={vi.fn()}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByTestId('tile-upload-failed')).toHaveTextContent('Upload interrupted');
    expect(screen.queryByTestId('tile-pending')).toBeNull();
  });

  it('crossfades from the local preview to the gateway thumbnail once it has loaded', () => {
    const onPreviewSwapped = vi.fn();
    render(
      <MediaGrid
        items={[{ ...item(1), thumbnailUrl: 'https://media.test/m/t1' }]}
        coverMediaId={null}
        effectiveCoverMediaId={null}
        localPreviews={new Map([[uuid(1), 'blob:local-1']])}
        onPreviewSwapped={onPreviewSwapped}
        onMove={vi.fn()}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const local = screen.getByTestId('tile-thumbnail');
    const remote = screen.getByTestId('tile-thumbnail-remote');
    expect(local).toHaveAttribute('src', 'blob:local-1');
    expect(remote).toHaveClass('opacity-0');
    expect(onPreviewSwapped).not.toHaveBeenCalled();
    fireEvent.load(remote);
    expect(remote).toHaveClass('opacity-100');
    expect(onPreviewSwapped).toHaveBeenCalledWith(uuid(1));
  });

  it('keeps the local preview when the gateway thumbnail fails to load', () => {
    const onPreviewSwapped = vi.fn();
    const onThumbnailError = vi.fn();
    render(
      <MediaGrid
        items={[{ ...item(1), thumbnailUrl: 'https://media.test/m/t1' }]}
        coverMediaId={null}
        effectiveCoverMediaId={null}
        localPreviews={new Map([[uuid(1), 'blob:local-1']])}
        onPreviewSwapped={onPreviewSwapped}
        onThumbnailError={onThumbnailError}
        onMove={vi.fn()}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.error(screen.getByTestId('tile-thumbnail-remote'));
    expect(screen.getByTestId('tile-thumbnail')).toHaveAttribute('src', 'blob:local-1');
    expect(screen.queryByTestId('tile-thumbnail-remote')).toBeNull();
    expect(onThumbnailError).toHaveBeenCalledWith(uuid(1));
    expect(onPreviewSwapped).not.toHaveBeenCalled();
  });

  it('reports a failed thumbnail and falls back to a neutral placeholder', () => {
    const onThumbnailError = vi.fn();
    render(
      <MediaGrid
        items={[{ ...item(1), thumbnailUrl: 'https://media.test/m/expired' }]}
        coverMediaId={null}
        effectiveCoverMediaId={null}
        onMove={vi.fn()}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
        onThumbnailError={onThumbnailError}
      />,
    );
    fireEvent.error(screen.getByTestId('tile-thumbnail'));
    expect(onThumbnailError).toHaveBeenCalledWith(uuid(1));
    expect(screen.queryByTestId('tile-thumbnail')).toBeNull();
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

describe('mergeThumbnails', () => {
  const withUrl = (n: number, url: string | null, status: EditorMediaItem['status'] = 'ready') => ({
    ...item(n, status),
    thumbnailUrl: url,
  });

  it('keeps the URL a tile already shows unless it went stale; takes new ones', () => {
    const prev = detail({
      items: [withUrl(1, 'u1-old'), withUrl(2, 'u2-old'), withUrl(3, null, 'processing')],
    });
    const next = detail({
      items: [withUrl(1, 'u1-new'), withUrl(2, 'u2-new'), withUrl(3, 'u3-new')],
    });
    expect(
      mergeThumbnails(prev, next, new Set([uuid(2)])).items.map((i) => i.thumbnailUrl),
    ).toEqual(['u1-old', 'u2-new', 'u3-new']);
  });

  it('drops URLs the server no longer returns', () => {
    const prev = detail({ items: [withUrl(1, 'u1-old')] });
    const next = detail({ items: [withUrl(1, null, 'failed')] });
    expect(mergeThumbnails(prev, next).items[0]!.thumbnailUrl).toBeNull();
  });
});

describe('tilePhase', () => {
  const local = (state: LocalUpload['state'], errorCode: string | null = null): LocalUpload => ({
    state,
    percent: 100,
    errorCode,
  });
  const cases: [string, EditorMediaItem['status'], LocalUpload | undefined, string][] = [
    ['reserved, no local', 'reserved', undefined, 'uploading'],
    ['uploading, local uploading', 'uploading', local('uploading'), 'uploading'],
    ['server uploading, local uploaded', 'uploading', local('uploaded'), 'finishing'],
    ['server uploading, local processing', 'uploading', local('processing'), 'finishing'],
    ['server uploaded, no local', 'uploaded', undefined, 'finishing'],
    ['server processing, no local', 'processing', undefined, 'finishing'],
    ['server ready', 'ready', local('uploading'), 'ready'],
    ['server ready, no local', 'ready', undefined, 'ready'],
    ['server failed beats local uploaded', 'failed', local('uploaded'), 'failed'],
    ['local processing_failed', 'processing', local('failed', 'processing_failed'), 'failed'],
    ['local failed upload', 'uploading', local('failed', 'network'), 'upload_failed'],
    ['server ready beats local failed', 'ready', local('failed', 'network'), 'ready'],
    ['deleting', 'deleting', local('uploaded'), 'removing'],
  ];
  it.each(cases)('%s', (_name, status, localUpload, expected) => {
    expect(tilePhase(item(1, status), localUpload)).toBe(expected);
  });
});

describe('useLocalPreviews', () => {
  const file = () => new File(['x'], 'a.jpg', { type: 'image/jpeg' });
  const upload = (state: LocalUpload['state'], percent = 100) => ({
    mediaId: uuid(1),
    state,
    percent,
    errorCode: null,
    file: file(),
  });

  it('releases a preview (revoked, not recreated) and fires onAdvance once per transition', () => {
    const revoke = vi.fn();
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:p1'), revokeObjectURL: revoke }),
    );
    const onAdvance = vi.fn();
    const { result } = renderHook(() => useLocalPreviews(new Set([uuid(1)]), vi.fn(), onAdvance));
    act(() => result.current.bridge.report([upload('uploading', 10)]));
    expect(result.current.previews.get(uuid(1))).toBe('blob:p1');
    expect(onAdvance).not.toHaveBeenCalled();
    act(() => result.current.bridge.report([upload('uploaded')]));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    act(() => result.current.bridge.report([upload('uploaded')]));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    act(() => result.current.bridge.report([upload('processing')]));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    act(() => result.current.bridge.report([upload('ready')]));
    expect(onAdvance).toHaveBeenCalledTimes(2);
    expect(result.current.local.get(uuid(1))?.state).toBe('ready');

    act(() => result.current.release(uuid(1)));
    expect(revoke).toHaveBeenCalledWith('blob:p1');
    expect(result.current.previews.has(uuid(1))).toBe(false);
    act(() => result.current.bridge.report([upload('ready')]));
    expect(result.current.previews.has(uuid(1))).toBe(false);
  });
});

describe('GalleryEditor readiness polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const getCount = () => calls.filter((c) => c.method === 'GET').length;

  it('backs off 2s, 3s, 4.5s while nothing changes, resets on change, stops when ready', async () => {
    let body = detail({ items: [item(1, 'processing')], itemCount: 1 });
    mockFetch(() => body);
    render(<GalleryEditor initial={detail({ items: [item(1, 'processing')], itemCount: 1 })} />);
    const step = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    await step(1_999);
    expect(getCount()).toBe(0);
    await step(1); // 2s
    expect(getCount()).toBe(1);
    await step(2_999);
    expect(getCount()).toBe(1);
    await step(1); // +3s
    expect(getCount()).toBe(2);
    await step(4_499);
    expect(getCount()).toBe(2);
    await step(1); // +4.5s
    expect(getCount()).toBe(3);

    // A change (a second photo appears, still processing) resets the delay to 2s.
    body = detail({ items: [item(1, 'processing'), item(2, 'processing')], itemCount: 2 });
    await step(6_750); // next unchanged-backoff poll: sees the change
    expect(getCount()).toBe(4);
    await step(1_999);
    expect(getCount()).toBe(4);
    await step(1);
    expect(getCount()).toBe(5);

    // Everything ready: one more refresh, then polling stops.
    body = detail({
      items: [
        { ...item(1), thumbnailUrl: 'https://media.test/m/1' },
        { ...item(2), thumbnailUrl: 'https://media.test/m/2' },
      ],
      itemCount: 2,
    });
    await step(3_000); // the 5th poll saw no change, so this one backed off to 3s
    expect(getCount()).toBe(6);
    await step(60_000);
    expect(getCount()).toBe(6);
  });

  it('announces a photo that failed processing and shows it as failed', async () => {
    mockFetch(() => detail({ items: [item(1, 'failed')], itemCount: 1 }));
    render(<GalleryEditor initial={detail({ items: [item(1, 'processing')], itemCount: 1 })} />);
    await act(() => vi.advanceTimersByTimeAsync(2_100));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(
      screen.getByText('IMG_1.jpg couldn’t be processed. Delete it or upload it again.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('tile-failed')).toBeInTheDocument();
  });
});

describe('GalleryEditor', () => {
  it('refetches a fresh thumbnail URL when one fails to load', async () => {
    const initial = detail({ items: [{ ...item(1), thumbnailUrl: 'https://media.test/m/old' }] });
    mockFetch(() => detail({ items: [{ ...item(1), thumbnailUrl: 'https://media.test/m/new' }] }));
    render(<GalleryEditor initial={initial} />);
    fireEvent.error(screen.getByTestId('tile-thumbnail'));
    await waitFor(() =>
      expect(screen.getByTestId('tile-thumbnail')).toHaveAttribute(
        'src',
        'https://media.test/m/new',
      ),
    );
    expect(calls).toEqual([
      { url: `/api/v1/galleries/${uuid(99)}`, method: 'GET', body: undefined },
    ]);
    // A second failure within the retry window does not refetch again.
    fireEvent.error(screen.getByTestId('tile-thumbnail'));
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toHaveLength(1);
  });

  it('shows local previews from the uploader and picks up new uploads', async () => {
    const createObjectURL = vi.fn(() => 'blob:local-7');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    mockFetch(() => detail({ items: [item(1), item(7, 'processing')], itemCount: 2 }));
    function FakeUploader() {
      const bridge = useContext(UploadBridgeContext);
      useEffect(() => {
        bridge?.report([
          {
            mediaId: uuid(7),
            state: 'processing',
            percent: 100,
            errorCode: null,
            file: new File(['x'], 'new.jpg', { type: 'image/jpeg' }),
          },
        ]);
      }, [bridge]);
      return null;
    }
    render(
      <GalleryEditor
        initial={detail({ items: [item(1)], itemCount: 1 })}
        uploadSlot={<FakeUploader />}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    const tile = within(screen.getAllByRole('listitem')[1]!);
    expect(tile.getByTestId('tile-thumbnail')).toHaveAttribute('src', 'blob:local-7');
    expect(tile.getByTestId('tile-finishing')).toHaveTextContent('Processing');
    expect(tile.queryByTestId('tile-pending')).toBeNull();
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

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

  it('multi-select: checkbox, shift range, toolbar, Escape clears', async () => {
    mockFetch(() => detail());
    render(<GalleryEditor initial={detail({ items: [item(1), item(2), item(3), item(4)] })} />);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select IMG_1.jpg' }));
    const bar = screen.getByRole('toolbar', { name: 'Selected photos' });
    expect(bar).toHaveTextContent('1 selected');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select IMG_3.jpg' }), {
      shiftKey: true,
    });
    expect(bar).toHaveTextContent('3 selected');
    expect(screen.getByRole('checkbox', { name: 'Select IMG_4.jpg' })).not.toBeChecked();

    // Ctrl-click on the tile toggles it.
    const tiles = screen.getAllByTestId('media-tile');
    fireEvent.click(tiles[1]!, { ctrlKey: true });
    expect(bar).toHaveTextContent('2 selected');

    await userEvent.click(within(bar).getByRole('button', { name: 'Select all' }));
    expect(bar).toHaveTextContent('4 selected');

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('bulk delete needs confirmation, then removes the selection with one request', async () => {
    mockFetch((call) =>
      call.method === 'POST'
        ? { mediaIds: [uuid(1), uuid(3)], contentVersion: 2, coverMediaId: null }
        : detail({ items: [item(2)], itemCount: 1 }),
    );
    render(<GalleryEditor initial={detail({ items: [item(1), item(2), item(3)] })} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select IMG_1.jpg' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select IMG_3.jpg' }));
    await userEvent.click(
      within(screen.getByRole('toolbar')).getByRole('button', { name: /Delete/ }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete 2 photos?' });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
    // Cancelling the dialog keeps the selection.
    expect(screen.getByRole('toolbar')).toHaveTextContent('2 selected');
    void dialog;

    await userEvent.click(
      within(screen.getByRole('toolbar')).getByRole('button', { name: /Delete/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete photos' }));
    await waitFor(() => expect(screen.queryByText('IMG_1.jpg')).not.toBeInTheDocument());
    expect(screen.queryByText('IMG_3.jpg')).not.toBeInTheDocument();
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/galleries/${uuid(99)}/media/bulk-delete`,
      body: { mediaIds: [uuid(1), uuid(3)] },
    });
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('single-photo actions still work while a selection exists', async () => {
    mockFetch(() => ({ contentVersion: 2, updated: 1, rebalanced: false }));
    render(<GalleryEditor initial={detail()} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select IMG_1.jpg' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move IMG_3.jpg earlier' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      body: { orderedIds: [uuid(1), uuid(3), uuid(2)] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Delete IMG_2.jpg' }));
    expect(screen.getByRole('dialog', { name: 'Delete this photo?' })).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('button', { name: 'Rename gallery' }));
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
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.getByText('Link copied.')).toBeInTheDocument();
  });

  it('falls back to selecting the link when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    document.execCommand = vi.fn(() => false);
    render(<ShareSheet url={url} title="Trip" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(screen.getByText(/Link selected/)).toBeInTheDocument();
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
