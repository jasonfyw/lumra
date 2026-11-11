import * as zlib from 'node:zlib';
import { crc32 as jsCrc32, type Crc32Fn } from '@lumra/media';

/**
 * CRC-32 for archive builds (ADR-003): workerd (with `nodejs_compat`) and Node ≥ 22.2 implement
 * `node:zlib` `crc32` natively, which keeps a 2 GB archive part to a fraction of a second of CPU.
 * Falls back to the pure-JS slice-by-8 implementation (identical results) when it is absent.
 */
const native = (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

export const archiveCrc32: Crc32Fn =
  typeof native === 'function' ? (data, initial = 0) => native(data, initial) : jsCrc32;

export const nativeCrc32Available = typeof native === 'function';
