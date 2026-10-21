/**
 * Product limits from PRD §5. Decimal units: 1 MB = 1_000_000 bytes, 1 GB = 1_000_000_000 bytes.
 * Values marked Proposed in the PRD are defaults that may be tuned without a PRD change.
 */
export const BYTES_PER_MB = 1_000_000;
export const BYTES_PER_GB = 1_000_000_000;

export const GUEST_LIMITS = {
  maxFiles: 20,
  maxBytes: 250 * BYTES_PER_MB,
  draftTtlMs: 24 * 60 * 60 * 1000,
} as const;

export const UPLOAD_LIMITS = {
  maxPhotoBytes: 50 * BYTES_PER_MB,
  /** Proposed: files above this use multipart upload (8 MiB). */
  multipartThresholdBytes: 8 * 1024 * 1024,
  partSizeBytes: 8 * 1024 * 1024,
  presignTtlSeconds: 15 * 60,
  concurrentFilesDesktop: 3,
  concurrentFilesMobile: 2,
  /** Proposed: stale authenticated reservations are failed/cleaned after 48 h. */
  authReservationTtlMs: 48 * 60 * 60 * 1000,
} as const;

export const ACCEPTED_PHOTO_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;
export type AcceptedPhotoMime = (typeof ACCEPTED_PHOTO_MIME_TYPES)[number];

export const GALLERY_LIMITS = {
  maxItemsPerGallery: 2_000,
  defaultTitle: 'Untitled gallery',
} as const;

export const DERIVATIVE_WIDTHS = [320, 640, 1280, 2048] as const;

export const ARCHIVE_LIMITS = {
  /** Proposed partition bounds (FR-D03). */
  maxItemsPerPart: 500,
  maxBytesPerPart: 2 * BYTES_PER_GB,
  retentionMs: 24 * 60 * 60 * 1000,
} as const;

export const MEDIA_TOKEN = {
  audience: 'lumra-media',
  maxTtlSeconds: 5 * 60,
} as const;

export const ANALYTICS = {
  viewDedupeWindowMs: 30 * 60 * 1000,
} as const;
