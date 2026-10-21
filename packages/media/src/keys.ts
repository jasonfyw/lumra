/**
 * Object key scheme (PRD §6.2). Keys are built only from server-issued opaque IDs —
 * never from user-supplied filenames — so callers cannot traverse or overwrite other keys.
 */
const OPAQUE_ID = /^[A-Za-z0-9-]{8,64}$/;
const VARIANT_HASH = /^[a-z0-9]{4,64}$/;

function assertOpaque(name: string, value: string): void {
  if (!OPAQUE_ID.test(value)) throw new Error(`Invalid ${name} for storage key`);
}

export function originalKey(ownerOpaqueId: string, galleryId: string, mediaId: string): string {
  assertOpaque('ownerOpaqueId', ownerOpaqueId);
  assertOpaque('galleryId', galleryId);
  assertOpaque('mediaId', mediaId);
  return `originals/${ownerOpaqueId}/${galleryId}/${mediaId}/source`;
}

export function derivativeKey(galleryId: string, mediaId: string, variantHash: string): string {
  assertOpaque('galleryId', galleryId);
  assertOpaque('mediaId', mediaId);
  if (!VARIANT_HASH.test(variantHash)) throw new Error('Invalid variantHash for storage key');
  return `derivatives/${galleryId}/${mediaId}/${variantHash}.webp`;
}

export function archivePartKey(galleryId: string, jobId: string, partNo: number): string {
  assertOpaque('galleryId', galleryId);
  assertOpaque('jobId', jobId);
  if (!Number.isInteger(partNo) || partNo < 1) throw new Error('Invalid partNo for storage key');
  return `archives/${galleryId}/${jobId}/${partNo}.zip`;
}
