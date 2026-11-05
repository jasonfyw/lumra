import { UPLOAD_LIMITS } from '@lumra/config';

const MIB = 1024 * 1024;

export interface UploadPlan {
  /** True when the file goes up as an S3 multipart upload rather than a single PUT. */
  multipart: boolean;
  /** Bytes per part (every part but the last). Equals `size` for a single PUT. */
  partSize: number;
  partCount: number;
}

/**
 * Decide how a file of `size` bytes is uploaded (FR-M03, PRD §6.2).
 *
 * - `size <= multipartThresholdBytes` → one presigned PUT.
 * - Otherwise multipart with `partSizeBytes`, grown in whole MiB if needed so the upload
 *   stays within S3/R2 rules: parts >= 5 MiB except the last, at most 10,000 parts.
 */
export function planUpload(size: number): UploadPlan {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError('size must be a positive integer number of bytes');
  }
  if (size > UPLOAD_LIMITS.maxPhotoBytes) {
    throw new RangeError('size exceeds the per-photo upload limit');
  }
  if (size <= UPLOAD_LIMITS.multipartThresholdBytes) {
    return { multipart: false, partSize: size, partCount: 1 };
  }
  const minForCount = Math.ceil(Math.ceil(size / UPLOAD_LIMITS.maxPartCount) / MIB) * MIB;
  const partSize = Math.max(
    UPLOAD_LIMITS.partSizeBytes,
    UPLOAD_LIMITS.minPartSizeBytes,
    minForCount,
  );
  return { multipart: true, partSize, partCount: Math.ceil(size / partSize) };
}

/** Byte length of part `partNumber` (1-based) under `plan` for a file of `size` bytes. */
export function partLength(plan: UploadPlan, size: number, partNumber: number): number {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > plan.partCount) {
    throw new RangeError('partNumber out of range for this upload plan');
  }
  return partNumber < plan.partCount ? plan.partSize : size - plan.partSize * (plan.partCount - 1);
}

/**
 * Rebuilds the plan persisted on an upload session (`reserved_bytes`, `part_size`) so later calls
 * keep using the intent's plan even if the configured part size changes in between.
 */
export function planFromReservation(size: number, partSize: number): UploadPlan {
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(partSize) || partSize < 1) {
    throw new RangeError('size and partSize must be positive integers');
  }
  if (partSize >= size) return { multipart: false, partSize: size, partCount: 1 };
  return { multipart: true, partSize, partCount: Math.ceil(size / partSize) };
}

export type PartListProblem =
  | { problem: 'missing_parts'; partNumbers: number[] }
  | { problem: 'unexpected_parts'; partNumbers: number[] }
  | { problem: 'duplicate_parts'; partNumbers: number[] };

/**
 * Checks that `partNumbers` is exactly 1..partCount (any order, no duplicates) — a multipart
 * upload is only completed when every planned part is present (FR-M04).
 */
export function checkCompletePartNumbers(
  plan: UploadPlan,
  partNumbers: readonly number[],
): PartListProblem | null {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const n of partNumbers) (seen.has(n) ? duplicates : seen).add(n);
  if (duplicates.size)
    return { problem: 'duplicate_parts', partNumbers: [...duplicates].sort((a, b) => a - b) };
  const unexpected = [...seen].filter((n) => !Number.isInteger(n) || n < 1 || n > plan.partCount);
  if (unexpected.length)
    return { problem: 'unexpected_parts', partNumbers: unexpected.sort((a, b) => a - b) };
  const missing: number[] = [];
  for (let n = 1; n <= plan.partCount && missing.length < 50; n++)
    if (!seen.has(n)) missing.push(n);
  if (missing.length) return { problem: 'missing_parts', partNumbers: missing };
  return null;
}

/** Normalises an S3 ETag for comparison (strips quotes and a weak `W/` prefix). */
export function normalizeEtag(etag: string): string {
  return etag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}
