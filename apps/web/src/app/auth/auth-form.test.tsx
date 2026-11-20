import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFormState } from './actions';

vi.mock('./actions', () => ({ sendOtpAction: vi.fn(), verifyOtpAction: vi.fn() }));

import { useCooldown } from './auth-form';

const base: AuthFormState = {
  step: 'email',
  email: 'a@b.co',
  error: null,
  notice: null,
  sentAt: null,
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useCooldown', () => {
  it('is 0 with no send or limit', () => {
    const { result } = renderHook(() => useCooldown(base));
    expect(result.current).toBe(0);
  });

  it('starts a proactive 60 s cooldown after a successful send and reaches 0', () => {
    const state = { ...base, step: 'code' as const, sentAt: 1 };
    const { result } = renderHook(() => useCooldown(state));
    expect(result.current).toBe(60);
    act(() => void vi.advanceTimersByTime(15_000));
    expect(result.current).toBe(45);
    act(() => void vi.advanceTimersByTime(45_000));
    expect(result.current).toBe(0);
  });

  it('counts down the server retryAfterSeconds after a rate-limited send', () => {
    const state = { ...base, error: 'x', retryAfterSeconds: 45 };
    const { result } = renderHook(() => useCooldown(state));
    expect(result.current).toBe(45);
    act(() => void vi.advanceTimersByTime(44_000));
    expect(result.current).toBe(1);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(0);
  });

  it('restarts when a new state arrives', () => {
    const { result, rerender } = renderHook(({ s }) => useCooldown(s), {
      initialProps: { s: { ...base, retryAfterSeconds: 10 } },
    });
    act(() => void vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(0);
    rerender({ s: { ...base, retryAfterSeconds: 30 } });
    expect(result.current).toBe(30);
  });
});
