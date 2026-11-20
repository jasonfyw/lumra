import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackButton, useTransientFlag } from './feedback-button';

function Demo({ ms }: { ms?: number }) {
  const [done, flash] = useTransientFlag(ms);
  return (
    <FeedbackButton
      onClick={flash}
      className="lm-btn"
      icon="copy"
      label="Copy link"
      doneLabel="Copied"
      announcement="Link copied."
      done={done}
    />
  );
}

describe('FeedbackButton', () => {
  afterEach(() => vi.useRealTimers());

  it('swaps to the confirmation label, announces it, and reverts after the delay', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Demo ms={2000} />);
    const button = screen.getByRole('button', { name: 'Copy link' });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    await user.click(button);
    expect(screen.getByRole('button', { name: 'Copied' })).toBe(button);
    expect(button).toHaveAttribute('data-done');
    expect(screen.getByRole('status')).toHaveTextContent('Link copied.');

    act(() => vi.advanceTimersByTime(1900));
    expect(button).toHaveAttribute('data-done');
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole('button', { name: 'Copy link' })).toBe(button);
    expect(button).not.toHaveAttribute('data-done');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('restarts the timer when triggered again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Demo ms={2000} />);
    const button = screen.getByRole('button', { name: 'Copy link' });
    await user.click(button);
    act(() => vi.advanceTimersByTime(1500));
    await user.click(button);
    act(() => vi.advanceTimersByTime(1500));
    expect(button).toHaveAttribute('data-done');
    act(() => vi.advanceTimersByTime(600));
    expect(button).not.toHaveAttribute('data-done');
  });
});
