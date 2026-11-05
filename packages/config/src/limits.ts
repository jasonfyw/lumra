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
  /** S3/R2 multipart rules: every part except the last is >= 5 MiB; at most 10,000 parts. */
  minPartSizeBytes: 5 * 1024 * 1024,
  maxPartCount: 10_000,
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

/** Accepted filename extensions (FR-M01). `.heif` is the same container as `.heic`. */
export const ACCEPTED_PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'] as const;

export const IMAGE_VALIDATION = {
  /** Proposed: decompression-bomb guard. Images above this many pixels are rejected (FR-M01). */
  maxPixels: 100_000_000,
  /**
   * Bytes read from the start of a file for type sniffing (client pre-check and worker).
   * Large enough to reach JPEG SOF markers behind EXIF/XMP/ICC segments and HEIF `meta` boxes.
   */
  sniffBytes: 256 * 1024,
} as const;

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

/**
 * Justified grid tunables (PRD §4 "Justified grid", T17). Row heights are CSS px.
 * Desktop rows stay ~180–280 px (target 220); mobile ~110–190 px (target 150).
 */
export const JUSTIFIED_LAYOUT = {
  /** Container widths below this use the mobile row heights. */
  mobileBreakpointPx: 768,
  desktop: { targetRowHeight: 220, minRowHeight: 180, maxRowHeight: 280, gap: 4 },
  mobile: { targetRowHeight: 150, minRowHeight: 110, maxRowHeight: 190, gap: 2 },
  /** Aspect ratio (w/h) used for placeholders whose dimensions are not known yet. */
  defaultAspectRatio: 3 / 2,
  /** Extra px rendered above/below the viewport by the windowed grid. */
  overscanPx: 800,
} as const;

/** Fractional ordering keys (FR-G03, T15). Keys longer than this trigger a full rebalance. */
export const ORDERING = {
  maxKeyLength: 32,
} as const;
