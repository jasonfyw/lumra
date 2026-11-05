import { UPLOAD_LIMITS } from '@lumra/config';
import { describe, expect, it } from 'vitest';
import { partLength, planUpload } from './upload-plan';

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
