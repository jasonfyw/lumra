// Container smoke test (CI + local): POSTs the committed HEIC fixture to a running processor and
// checks that it decodes into a valid WebP derivative. Proves the image's libheif has an HEVC
// decoder, which sharp's prebuilt binaries (used by `pnpm test`) do not.
//
//   docker run -d --rm -p 8080:8080 --name lumra-processor lumra-image-processor:dev
//   node apps/image-processor/scripts/smoke.mjs http://127.0.0.1:8080
import { readFile } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const mediaId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('processor did not become healthy');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`smoke: FAIL ${message}`);
    process.exit(1);
  }
}

await waitForHealth();
const heic = await readFile(new URL('../test/fixtures/gradient-400x300.heic', import.meta.url));
const res = await fetch(`${base}/process`, {
  method: 'POST',
  body: heic,
  headers: {
    'content-type': 'application/octet-stream',
    'x-lumra-media-id': mediaId,
    'x-lumra-expected-mime': 'image/heic',
    'x-request-id': 'smoke',
  },
});
if (!res.ok) console.error(await res.text());
assert(res.ok, `HEIC /process returned ${res.status}`);
const form = await res.formData();
const manifest = JSON.parse(form.get('manifest'));
assert(manifest.source.mime === 'image/heic', 'source mime is image/heic');
assert(manifest.source.width === 400 && manifest.source.height === 300, 'source is 400x300');
assert(manifest.variants.length === 1, 'one variant for a 400px source');
const variant = manifest.variants[0];
assert(
  variant.variant === 'w320' && variant.width === 320 && variant.height === 240,
  'w320 320x240',
);
const bytes = new Uint8Array(await form.get('w320').arrayBuffer());
const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
assert(ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP', 'variant is a WebP file');
assert(!new TextDecoder('latin1').decode(bytes).includes('Exif'), 'variant carries no EXIF');

const bomb = await fetch(`${base}/process`, {
  method: 'POST',
  body: new Uint8Array(8),
  headers: { 'x-lumra-media-id': mediaId, 'x-lumra-expected-mime': 'image/jpeg' },
});
assert(bomb.status === 422, `garbage input is a 422 rejection (got ${bomb.status})`);
console.info(
  `smoke: OK HEIC decoded → ${variant.width}x${variant.height} WebP (${variant.byteSize} B)`,
);
