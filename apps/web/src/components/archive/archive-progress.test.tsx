import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_LIMITS } from '@lumra/config';
import { makeArchiveFixture } from '@/app/dev/archive/fixture';
import { DownloadAllButton } from '@/components/gallery/download-all-button';
import { ArchiveProgress } from './archive-progress';

const refresh = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push }) }));

function json(data: unknown, status = 200, error: unknown = null) {
  return new Response(JSON.stringify({ data, error, requestId: 'r' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const NEW_JOB = '8e1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  refresh.mockReset();
  push.mockReset();
});

describe('ArchiveProgress', () => {
  it('shows progress while preparing and polls until ready, then lists part links', async () => {
    const ready = makeArchiveFixture('ready', 3);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ ...makeArchiveFixture('processing', 3), progressPct: 80 }))
      .mockResolvedValue(json(ready));
    vi.stubGlobal('fetch', fetchMock);
    render(<ArchiveProgress initial={makeArchiveFixture('preparing', 3)} />);

    expect(screen.getByRole('heading', { name: 'Preparing your download' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');

    await act(() => vi.advanceTimersByTimeAsync(ARCHIVE_LIMITS.pollIntervalMs));
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/public/archives/${ready.jobId}`, {
      cache: 'no-store',
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80');

    await act(() => vi.advanceTimersByTimeAsync(ARCHIVE_LIMITS.pollIntervalMs));
    expect(
      screen.getByRole('heading', { name: 'Your download is ready in 3 parts' }),
    ).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /^Download Part/ });
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveAttribute('href', ready.parts[0]!.downloadUrl);
    expect(links[0]).toHaveClass('lm-btn-primary');
    expect(links[1]).toHaveClass('lm-btn-secondary');

    // The next part to fetch becomes the primary action once one is started.
    fireEvent.click(links[0]!);
    expect(screen.getByText('Started')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Download Part/ })[1]).toHaveClass(
      'lm-btn-primary',
    );

    // No more polling once ready, except to refresh URLs before they expire.
    const calls = fetchMock.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(ARCHIVE_LIMITS.pollIntervalMs * 3));
    expect(fetchMock.mock.calls.length).toBe(calls);
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it('refreshes the route when access is lost (password change, expiry, deletion)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(null, 404)));
    render(<ArchiveProgress initial={makeArchiveFixture('processing', 1)} />);
    await act(() => vi.advanceTimersByTimeAsync(ARCHIVE_LIMITS.pollIntervalMs));
    expect(refresh).toHaveBeenCalled();
  });

  it('offers Try again for a failed archive and opens the new job', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json(
          { jobId: NEW_JOB, reused: false, status: 'preparing', itemCount: 3, partsExpected: 1 },
          201,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<ArchiveProgress initial={makeArchiveFixture('failed', 1)} />);
    expect(screen.getByRole('alert')).toHaveTextContent('We couldn’t finish this download');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/public/galleries/dev-fixture/archives',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(push).toHaveBeenCalledWith(`/archive/${NEW_JOB}`);
  });

  it('explains expiry and shows a retry error inline', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          json(null, 429, { code: 'rate_limited', message: 'Slow down.', retryable: true }),
        ),
    );
    render(<ArchiveProgress initial={makeArchiveFixture('expired', 2)} />);
    expect(screen.getByRole('heading', { name: 'This download has expired' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Download/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare a new download' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole('alert')).toHaveTextContent('Slow down.');
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back to the gallery' })).toHaveAttribute(
      'href',
      '/g/dev-fixture',
    );
  });

  it('does not poll in fixture mode', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<ArchiveProgress initial={makeArchiveFixture('processing', 1)} live={false} />);
    await act(() => vi.advanceTimersByTimeAsync(ARCHIVE_LIMITS.pollIntervalMs * 3));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DownloadAllButton', () => {
  it('is hidden when nothing is ready', () => {
    const { container } = render(<DownloadAllButton slug="abc" readyCount={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('creates the archive and routes to its progress page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json({ jobId: NEW_JOB, reused: true, status: 'ready', itemCount: 3, partsExpected: 1 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<DownloadAllButton slug="a b" readyCount={3} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/public/galleries/a%20b/archives',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect(push).toHaveBeenCalledWith(`/archive/${NEW_JOB}`);
  });

  it('shows the server message when the archive is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json(null, 403, {
          code: 'quota_exceeded',
          message: 'Downloading everything at once is temporarily unavailable for this gallery.',
          retryable: false,
        }),
      ),
    );
    render(<DownloadAllButton slug="abc" readyCount={3} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download all' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(screen.getByRole('button', { name: 'Download all' })).toBeEnabled();
  });
});
