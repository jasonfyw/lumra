import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UploadEngine, type UploadItemSnapshot, type UploadSnapshot } from '@/lib/upload';
import { FakeLumra, photo, readPrefix, uuid } from '@/lib/upload/test-fakes';
import { UploadList, summarize } from './upload-list';
import { UploadZone } from './upload-zone';

function item(overrides: Partial<UploadItemSnapshot>): UploadItemSnapshot {
  return {
    clientId: uuid(),
    name: 'IMG_0001.jpg',
    size: 2_000_000,
    type: 'image/jpeg',
    state: 'queued',
    bytesUploaded: 0,
    percent: 0,
    error: null,
    mediaId: null,
    hasFile: true,
    ...overrides,
  };
}

function snapshotOf(items: UploadItemSnapshot[]): UploadSnapshot {
  const done = items.filter((i) => ['uploaded', 'processing', 'ready'].includes(i.state)).length;
  const totalBytes = items.reduce((n, i) => n + i.size, 0);
  const uploadedBytes = items.reduce((n, i) => n + i.bytesUploaded, 0);
  return {
    items,
    totals: {
      totalBytes,
      uploadedBytes,
      percent: totalBytes ? Math.floor((uploadedBytes / totalBytes) * 100) : 0,
      queued: items.filter((i) => i.state === 'queued').length,
      uploading: items.filter((i) => i.state === 'uploading').length,
      done,
      failed: items.filter((i) => i.state === 'failed').length,
      awaitingFile: items.filter((i) => i.state === 'awaiting_file').length,
    },
    authPrompt: null,
    concurrency: 3,
    galleryReady: true,
  };
}

describe('UploadZone', () => {
  it('opens the native picker from the keyboard', async () => {
    const user = userEvent.setup();
    render(<UploadZone onFiles={vi.fn()} />);
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    expect(input.multiple).toBe(true);
    expect(input.accept).toContain('image/heic');
    expect(input.accept).toContain('.jpg');

    await user.tab();
    const button = screen.getByRole('button', { name: 'Choose photos' });
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(click).toHaveBeenCalledTimes(2);
  });

  it('shows a clear rejection for unsupported files before any upload', async () => {
    const fake = new FakeLumra();
    const engine = new UploadEngine({
      api: fake.api,
      transport: fake.transport,
      mode: 'guest',
      galleryId: fake.galleryId,
      hasher: null,
    });
    const user = userEvent.setup({ applyAccept: false });
    render(<UploadZone onFiles={(files) => engine.addFiles(files)} />);
    await user.upload(screen.getByTestId('upload-input'), [
      new File(['raw'], 'DSC_0001.NEF', { type: 'image/x-nikon-nef' }),
      new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
    ]);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('2 files weren’t added');
    expect(alert).toHaveTextContent('DSC_0001.NEF isn’t a supported photo');
    expect(alert).toHaveTextContent('Use JPEG, PNG, WebP or HEIC');
    expect(fake.calls).toEqual([]);
    engine.dispose();
  });

  it('accepts dropped files', async () => {
    const onFiles = vi.fn(() => ({ added: 1, rejected: [] }));
    render(<UploadZone onFiles={onFiles} />);
    const zone = screen.getByRole('region', { name: 'Add photos' });
    const file = photo('a.jpg', 100);
    const dataTransfer = { files: [file], types: ['Files'], dropEffect: 'none' };
    await act(async () => {
      zone.dispatchEvent(Object.assign(new Event('drop', { bubbles: true }), { dataTransfer }));
    });
    expect(onFiles).toHaveBeenCalledWith([file]);
  });
});

describe('UploadList', () => {
  it('renders per-file status, total progress and actions', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    const onRemove = vi.fn();
    const failed = item({
      name: 'beach.jpg',
      state: 'failed',
      error: {
        code: 'upload_interrupted',
        message: 'Upload interrupted. Check your connection and retry.',
        retryable: true,
      },
    });
    const uploading = item({
      name: 'sunset.jpg',
      state: 'uploading',
      bytesUploaded: 1_000_000,
      percent: 50,
    });
    render(
      <UploadList
        snapshot={snapshotOf([failed, uploading])}
        onRetry={onRetry}
        onCancel={onCancel}
        onRemove={onRemove}
      />,
    );
    expect(
      screen.getByText('Upload interrupted. Check your connection and retry.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Uploading 50% · 1 MB of 2 MB')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Total upload progress' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );

    await user.click(screen.getByRole('button', { name: 'Retry beach.jpg' }));
    await user.click(screen.getByRole('button', { name: 'Cancel sunset.jpg' }));
    await user.click(screen.getByRole('button', { name: 'Remove beach.jpg' }));
    expect(onRetry).toHaveBeenCalledWith(failed.clientId);
    expect(onCancel).toHaveBeenCalledWith(uploading.clientId);
    expect(onRemove).toHaveBeenCalledWith(failed.clientId);
    for (const button of screen.getAllByRole('button'))
      expect(button.className).toContain('min-h-11');
  });

  it('announces progress politely and throttles updates', () => {
    vi.useFakeTimers();
    try {
      const a = item({ state: 'uploading', percent: 10, bytesUploaded: 200_000 });
      const props = {
        onRetry: vi.fn(),
        onCancel: vi.fn(),
        onRemove: vi.fn(),
        announceIntervalMs: 3000,
      };
      const { rerender } = render(<UploadList snapshot={snapshotOf([a])} {...props} />);
      const live = screen.getByTestId('upload-announcer');
      expect(live).toHaveAttribute('aria-live', 'polite');
      expect(live).toHaveTextContent('Uploading: 0 of 1 photos done, 10% overall.');

      act(() => vi.advanceTimersByTime(3000));
      rerender(
        <UploadList
          snapshot={snapshotOf([{ ...a, percent: 40, bytesUploaded: 800_000 }])}
          {...props}
        />,
      );
      expect(live).toHaveTextContent('40% overall');
      rerender(
        <UploadList
          snapshot={snapshotOf([{ ...a, percent: 60, bytesUploaded: 1_200_000 }])}
          {...props}
        />,
      );
      expect(live).toHaveTextContent('40% overall'); // throttled
      act(() => vi.advanceTimersByTime(3000));
      expect(live).toHaveTextContent('60% overall');

      rerender(
        <UploadList
          snapshot={snapshotOf([{ ...a, state: 'uploaded', bytesUploaded: a.size }])}
          {...props}
        />,
      );
      act(() => vi.advanceTimersByTime(3000));
      expect(live).toHaveTextContent('All 1 photo uploaded.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('summarizes failures and files waiting to be reselected', () => {
    expect(
      summarize(
        snapshotOf([
          item({ state: 'ready', bytesUploaded: 2_000_000 }),
          item({ state: 'failed' }),
          item({ state: 'awaiting_file' }),
        ]),
      ),
    ).toBe(
      '1 of 3 photos uploaded. 1 needs attention. 1 waiting for you to choose the files again.',
    );
  });
});

describe('UploadZone + engine', () => {
  it('lists accepted files and uploads them', async () => {
    const fake = new FakeLumra();
    const engine = new UploadEngine({
      api: fake.api,
      transport: fake.transport,
      mode: 'guest',
      galleryId: fake.galleryId,
      hasher: null,
      readPrefix,
      progressThrottleMs: 0,
    });
    const user = userEvent.setup();
    function Harness() {
      const snap = engine.getSnapshot();
      return (
        <>
          <UploadZone onFiles={(files) => engine.addFiles(files)} />
          <UploadList snapshot={snap} onRetry={vi.fn()} onCancel={vi.fn()} onRemove={vi.fn()} />
        </>
      );
    }
    const { rerender } = render(<Harness />);
    await user.upload(screen.getByTestId('upload-input'), [photo('a.jpg', 1000)]);
    await vi.waitFor(() => expect(engine.getSnapshot().items[0]?.state).toBe('uploaded'));
    rerender(<Harness />);
    expect(screen.getByText('Uploaded · processing soon')).toBeInTheDocument();
    engine.dispose();
  });
});
