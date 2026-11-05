import { UPLOAD_LIMITS } from '@lumra/config';
import { describe, expect, it } from 'vitest';
import {
  checkCompletePartNumbers,
  normalizeEtag,
  partLength,
  planFromReservation,
  planUpload,
} from './upload-plan';

describe('planFromReservation', () => {
  it('round-trips planUpload for persisted sessions', () => {
    for (const size of [1, 8 * 1024 * 1024, 8 * 1024 * 1024 + 1, 50_000_000]) {
      const plan = planUpload(size);
      expect(planFromReservation(size, plan.partSize)).toEqual(plan);
    }
  });

  it('rejects invalid values', () => {
    expect(() => planFromReservation(0, 1)).toThrow(RangeError);
    expect(() => planFromReservation(10, 0)).toThrow(RangeError);
  });
});

describe('checkCompletePartNumbers', () => {
  const plan = { multipart: true, partSize: 8 * 1024 * 1024, partCount: 3 };

  it('accepts exactly 1..partCount in any order', () => {
    expect(checkCompletePartNumbers(plan, [3, 1, 2])).toBeNull();
  });

  it('reports missing, unexpected and duplicate parts', () => {
    expect(checkCompletePartNumbers(plan, [1, 3])).toEqual({
      problem: 'missing_parts',
      partNumbers: [2],
    });
    expect(checkCompletePartNumbers(plan, [1, 2, 3, 10, 4])).toEqual({
      problem: 'unexpected_parts',
      partNumbers: [4, 10],
    });
    expect(checkCompletePartNumbers(plan, [1, 2, 2, 3])).toEqual({
      problem: 'duplicate_parts',
      partNumbers: [2],
    });
  });
});

describe('normalizeEtag', () => {
  it('strips quotes and weak prefixes', () => {
    expect(normalizeEtag('"abc123"')).toBe('abc123');
    expect(normalizeEtag('W/"abc123"')).toBe('abc123');
    expect(normalizeEtag('abc123')).toBe('abc123');
  });
});

const MIB = 1024 * 1024;

describe('planUpload', () => {
  it('uses a single PUT up to and including the threshold', () => {
    expect(planUpload(1)).toEqual({ multipart: false, partSize: 1, partCount: 1 });
    expect(planUpload(UPLOAD_LIMITS.multipartThresholdBytes)).toEqual({
      multipart: false,
      partSize: UPLOAD_LIMITS.multipartThresholdBytes,
      partCount: 1,
    });
  });

  it('switches to multipart above the threshold', () => {
    const size = UPLOAD_LIMITS.multipartThresholdBytes + 1;
    expect(planUpload(size)).toEqual({ multipart: true, partSize: 8 * MIB, partCount: 2 });
  });

  it('plans the 50 MB maximum within S3 part rules', () => {
    const size = UPLOAD_LIMITS.maxPhotoBytes;
    const plan = planUpload(size);
    expect(plan.multipart).toBe(true);
    expect(plan.partSize).toBeGreaterThanOrEqual(5 * MIB);
    expect(plan.partCount).toBeLessThanOrEqual(10_000);
    expect(plan.partCount).toBe(Math.ceil(size / (8 * MIB)));
    const last = partLength(plan, size, plan.partCount);
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThanOrEqual(plan.partSize);
    let total = 0;
    for (let n = 1; n <= plan.partCount; n++) total += partLength(plan, size, n);
    expect(total).toBe(size);
  });

  it('rejects invalid or oversized sizes', () => {
    expect(() => planUpload(0)).toThrow(RangeError);
    expect(() => planUpload(-5)).toThrow(RangeError);
    expect(() => planUpload(1.5)).toThrow(RangeError);
    expect(() => planUpload(Number.NaN)).toThrow(RangeError);
    expect(() => planUpload(UPLOAD_LIMITS.maxPhotoBytes + 1)).toThrow(RangeError);
  });

  it('rejects part numbers outside the plan', () => {
    const plan = planUpload(20 * MIB);
    expect(() => partLength(plan, 20 * MIB, 0)).toThrow(RangeError);
    expect(() => partLength(plan, 20 * MIB, plan.partCount + 1)).toThrow(RangeError);
  });
});
