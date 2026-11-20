// The one `node:zlib` export the worker uses (provided by workerd under `nodejs_compat`, and by
// Node in tests). Declared here because the worker compiles against workers-types only.
declare module 'node:zlib' {
  export function crc32(data: Uint8Array | string, value?: number): number;
}
