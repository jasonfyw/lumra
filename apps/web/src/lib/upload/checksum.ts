import { isAbortError } from './api-client';

/** Whole-file SHA-256 (hex) for `complete` (FR-M04), or null when it can't be computed. */
export type Hasher = (file: Blob, signal: AbortSignal) => Promise<string | null>;

const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Incremental SHA-256 with hash-wasm (`crypto.subtle.digest` is one-shot and would need the whole
 * 50 MB file in memory at once). The file is read in 4 MiB slices and the main thread is yielded
 * between slices, so a 50 MB photo costs roughly 13 short tasks instead of one long one; no worker
 * is needed at this size. It runs alongside the part uploads and is awaited only before
 * `complete`. Any failure (no WebAssembly, read error) returns null and the upload completes
 * without a checksum — integrity then rests on the server checks (docs/UPLOADS.md).
 */
export const sha256Hasher: Hasher = async (file, signal) => {
  try {
    const { createSHA256 } = await import('hash-wasm');
    const hasher = await createSHA256();
    hasher.init();
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const chunk = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
      hasher.update(new Uint8Array(chunk));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return hasher.digest('hex');
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
};
