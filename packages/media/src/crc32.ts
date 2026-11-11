/**
 * CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) as used by ZIP. Incremental:
 * `crc32(b, crc32(a))` equals `crc32(a ++ b)`. Pure JS (slice-by-8), so it runs anywhere;
 * runtimes with a native implementation (`node:zlib` `crc32` in Node ≥ 22.2 and workerd) can be
 * injected into the ZIP writer instead — both produce identical values.
 */
export type Crc32Fn = (data: Uint8Array, initial?: number) => number;

const TABLES: Uint32Array[] = (() => {
  const tables = Array.from({ length: 8 }, () => new Uint32Array(256));
  const t0 = tables[0]!;
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t0[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t0[n]!;
    for (let k = 1; k < 8; k++) {
      c = t0[c & 0xff]! ^ (c >>> 8);
      tables[k]![n] = c >>> 0;
    }
  }
  return tables;
})();

export const crc32: Crc32Fn = (data, initial = 0) => {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = TABLES as [
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
  ];
  let crc = ~initial >>> 0;
  let i = 0;
  const end8 = data.length - (data.length % 8);
  for (; i < end8; i += 8) {
    const a = (data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24)) ^ crc;
    crc =
      t7[a & 0xff]! ^
      t6[(a >>> 8) & 0xff]! ^
      t5[(a >>> 16) & 0xff]! ^
      t4[a >>> 24]! ^
      t3[data[i + 4]!]! ^
      t2[data[i + 5]!]! ^
      t1[data[i + 6]!]! ^
      t0[data[i + 7]!]!;
  }
  for (; i < data.length; i++) crc = t0[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
};
