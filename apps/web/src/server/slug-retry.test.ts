import { describe, expect, it, vi } from 'vitest';
import { MAX_SLUG_ATTEMPTS, isUniqueViolation, withSlugRetry } from './slug-retry';

const unique = () => Object.assign(new Error('duplicate key'), { code: '23505' });

describe('isUniqueViolation', () => {
  it('detects a direct or wrapped (cause) 23505', () => {
    expect(isUniqueViolation(unique())).toBe(true);
    expect(isUniqueViolation(new Error('x', { cause: { code: '23505' } }))).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error('x'), { code: '23503' }))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe('withSlugRetry', () => {
  it('retries a slug collision and succeeds with a fresh attempt', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(unique()).mockResolvedValueOnce('ok');
    await expect(withSlugRetry(attempt)).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('gives up after the maximum number of attempts', async () => {
    const attempt = vi.fn().mockRejectedValue(unique());
    await expect(withSlugRetry(attempt)).rejects.toMatchObject({ code: '23505' });
    expect(attempt).toHaveBeenCalledTimes(MAX_SLUG_ATTEMPTS);
  });

  it('does not retry other errors', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(withSlugRetry(attempt)).rejects.toThrow('boom');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
