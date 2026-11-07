import type { MediaRejectionCode } from '@lumra/contracts';

/** Client-side rejection reasons: the pre-check codes plus a duplicate pick. */
export type RejectionCode = MediaRejectionCode | 'duplicate' | 'unreadable';

const SUPPORTED = 'Use JPEG, PNG, WebP or HEIC.';

/** Actionable, user-facing text for a rejected file (FR-M08). */
export function rejectionMessage(name: string, code: RejectionCode): string {
  switch (code) {
    case 'unsupported_extension':
    case 'unsupported_type':
      return `${name} isn’t a supported photo. ${SUPPORTED} Videos and RAW files aren’t supported.`;
    case 'file_too_large':
      return `${name} is larger than 50 MB.`;
    case 'empty_file':
      return `${name} is empty.`;
    case 'truncated':
      return `${name} looks incomplete. Try exporting it again.`;
    case 'malformed':
      return `${name} looks damaged and can’t be read.`;
    case 'too_many_pixels':
      return `${name} has too many pixels (the limit is 100 megapixels).`;
    case 'heic_unsupported_variant':
      return `${name} uses a HEIC variant Lumra can’t process. Export it as JPEG and try again.`;
    case 'duplicate':
      return `${name} is already in this upload.`;
    case 'unreadable':
      return `${name} couldn’t be read. Choose it again.`;
  }
}
