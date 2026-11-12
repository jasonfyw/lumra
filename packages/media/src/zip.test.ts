import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { crc32 } from './crc32';
import { storedZipSize, ZipFormatError, ZipStreamWriter } from './zip';

/**
 * The writer's output is validated with real readers: Info-ZIP `unzip -t` (CRC + structure of
 * every entry, local headers included) and Python's `zipfile` (central directory, ZIP64 extra
 * fields, per-entry CRC via `testzip`). Both are present on CI's ubuntu runners; a missing tool
 * skips only its assertions.
 */
const has = (cmd: string, args: string[]) => spawnSync(cmd, args).status === 0;
const HAS_UNZIP = has('unzip', ['-v']);
const HAS_PYTHON = has('python3', ['-c', 'import zipfile']);

const dir = mkdtempSync(join(tmpdir(), 'lumra-zip-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function bytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** A body delivered in uneven chunks, like an R2 object stream. */
function streamOf(data: Uint8Array, chunk = 7_919): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= data.length) return controller.close();
      controller.enqueue(data.slice(at, at + chunk));
      at += chunk;
    },
  });
}

async function build(
  files: { name: string; data: Uint8Array }[],
  options: ConstructorParameters<typeof ZipStreamWriter>[1] = {},
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const writer = new ZipStreamWriter((c) => void chunks.push(c.slice()), options);
  for (const f of files) {
    await writer.addEntry(
      { name: f.name, size: f.data.length, modifiedAt: new Date('2026-10-12T14:03:22Z') },
      streamOf(f.data),
    );
  }
  const total = await writer.finish();
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  expect(at).toBe(total);
  return out;
}

let seq = 0;
function save(zip: Uint8Array): string {
  const path = join(dir, `t${++seq}.zip`);
  writeFileSync(path, zip);
  return path;
}

const PY_CHECK = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    out = {"bad": bad, "entries": [
        {"name": i.filename, "size": i.file_size, "crc": i.CRC, "method": i.compress_type,
         "flags": i.flag_bits, "data": z.read(i).hex()[:16]} for i in z.infolist()]}
print(json.dumps(out))
`;

function pyInspect(path: string) {
  return JSON.parse(
    execFileSync('python3', ['-I', '-c', PY_CHECK, path], { encoding: 'utf8' }),
  ) as {
    bad: string | null;
    entries: {
      name: string;
      size: number;
      crc: number;
      method: number;
      flags: number;
      data: string;
    }[];
  };
}

const FILES = [
  { name: 'IMG_0001.jpg', data: bytes(150_000, 1) },
  { name: 'empty.png', data: new Uint8Array(0) },
  { name: 'Ünïcødé – café (2).heic', data: bytes(33_333, 2) },
  { name: 'IMG_0002.JPG', data: bytes(1, 3) },
];

describe('crc32', () => {
  it('matches the reference value and node:zlib, incrementally', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const data = bytes(100_003, 9);
    const native = (zlib as unknown as { crc32?: (d: Uint8Array, v?: number) => number }).crc32;
    const whole = crc32(data);
    expect(crc32(data.subarray(50_001), crc32(data.subarray(0, 50_001)))).toBe(whole);
    if (native) expect(native(data, 0)).toBe(whole);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('ZipStreamWriter (STORE)', () => {
  it('produces an archive real unzip tools accept, byte-for-byte originals', async () => {
    const zip = await build(FILES);
    expect(zip.length).toBe(
      storedZipSize(FILES.map((f) => ({ name: f.name, size: f.data.length }))),
    );
    const path = save(zip);
    if (HAS_UNZIP) {
      const out = execFileSync('unzip', ['-t', path], { encoding: 'utf8' });
      expect(out).toMatch(/No errors detected/);
    }
    if (HAS_PYTHON) {
      const info = pyInspect(path);
      expect(info.bad).toBeNull();
      expect(info.entries.map((e) => e.name)).toEqual(FILES.map((f) => f.name));
      for (const [i, e] of info.entries.entries()) {
        expect(e.method).toBe(0); // stored, no recompression
        expect(e.size).toBe(FILES[i]!.data.length);
        expect(e.crc).toBe(crc32(FILES[i]!.data));
        expect(e.flags & 0x0808).toBe(0x0808);
        expect(e.data).toBe(Buffer.from(FILES[i]!.data.subarray(0, 8)).toString('hex'));
      }
    }
  });

  it('extracts exactly the original bytes', async () => {
    if (!HAS_UNZIP) return;
    const path = save(await build(FILES.slice(0, 1)));
    const extracted = execFileSync('unzip', ['-p', path, FILES[0]!.name]);
    expect(Buffer.compare(extracted, Buffer.from(FILES[0]!.data))).toBe(0);
  });

  it('writes valid ZIP64 structures (entries, offsets and end records)', async () => {
    const zip = await build(FILES, { forceZip64: true });
    const view = new DataView(zip.buffer);
    // ZIP64 end-of-central-directory locator sits just before the 22-byte EOCD.
    expect(view.getUint32(zip.length - 22 - 20, true)).toBe(0x07064b50);
    expect(view.getUint16(zip.length - 22 + 10, true)).toBe(0xffff);
    const path = save(zip);
    if (HAS_UNZIP) {
      expect(execFileSync('unzip', ['-t', path], { encoding: 'utf8' })).toMatch(
        /No errors detected/,
      );
    }
    if (HAS_PYTHON) {
      const info = pyInspect(path);
      expect(info.bad).toBeNull();
      expect(info.entries.map((e) => [e.name, e.size])).toEqual(
        FILES.map((f) => [f.name, f.data.length]),
      );
    }
  });

  it('accepts the native CRC implementation', async () => {
    const native = (zlib as unknown as { crc32?: (d: Uint8Array, v?: number) => number }).crc32;
    if (!native) return;
    const a = await build(FILES);
    const b = await build(FILES, { crc32: (d, v) => native(d, v ?? 0) });
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  it('an archive with no entries is still valid', async () => {
    const zip = await build([]);
    expect(zip.length).toBe(22);
    if (HAS_PYTHON) expect(pyInspect(save(zip)).entries).toEqual([]);
  });

  it('rejects bodies that do not match the declared size', async () => {
    const writer = new ZipStreamWriter(() => undefined);
    await expect(
      writer.addEntry({ name: 'a.jpg', size: 10 }, streamOf(bytes(11, 1))),
    ).rejects.toBeInstanceOf(ZipFormatError);
    const writer2 = new ZipStreamWriter(() => undefined);
    await expect(
      writer2.addEntry({ name: 'a.jpg', size: 10 }, streamOf(bytes(9, 1))),
    ).rejects.toThrow(/shorter/);
  });

  it('refuses path-like entry names (defence in depth, PRD §11)', async () => {
    for (const name of ['../x.jpg', 'a/b.jpg', 'a\\b.jpg', '..', '.', '', 'nul\u0000.jpg']) {
      const writer = new ZipStreamWriter(() => undefined);
      await expect(
        writer.addEntry({ name, size: 0 }, streamOf(new Uint8Array(0))),
      ).rejects.toBeInstanceOf(ZipFormatError);
    }
  });

  it('extracting with unzip never writes outside the target directory', async () => {
    if (!HAS_UNZIP) return;
    const target = mkdtempSync(join(dir, 'x-'));
    const path = save(await build(FILES));
    execFileSync('unzip', ['-q', path, '-d', target]);
    const listed = execFileSync('find', [target, '-type', 'f'], { encoding: 'utf8' })
      .trim()
      .split('\n');
    expect(listed).toHaveLength(FILES.length);
    for (const p of listed) expect(p.startsWith(target + '/')).toBe(true);
    expect(readFileSync(join(target, FILES[2]!.name)).length).toBe(FILES[2]!.data.length);
  });

  it('cannot add entries after finish', async () => {
    const writer = new ZipStreamWriter(() => undefined);
    await writer.finish();
    await expect(
      writer.addEntry({ name: 'a', size: 0 }, streamOf(new Uint8Array(0))),
    ).rejects.toThrow(/finished/);
    await expect(writer.finish()).rejects.toThrow(/finished/);
  });
});
