// Bundles the processor into dist/server.mjs for the container image. Workspace packages export
// TypeScript source, so they are inlined by esbuild; sharp (native) stays external and is built
// from source against the image's libvips (see Dockerfile). dist/package.json pins it.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const sharpVersion = pkg.dependencies.sharp;
if (!/^\d+\.\d+\.\d+$/.test(sharpVersion)) {
  throw new Error('sharp must be pinned to an exact version in package.json');
}

await mkdir(new URL('dist/', root), { recursive: true });
await build({
  entryPoints: [new URL('src/main.ts', root).pathname],
  outfile: new URL('dist/server.mjs', root).pathname,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['sharp'],
  banner: {
    // exif-reader is CommonJS; give the ESM bundle a require() for its interop shim.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
});

await writeFile(
  new URL('dist/package.json', root),
  `${JSON.stringify(
    {
      name: 'lumra-image-processor',
      private: true,
      type: 'module',
      dependencies: { sharp: sharpVersion },
    },
    null,
    2,
  )}\n`,
);
console.info(`built dist/server.mjs (sharp ${sharpVersion})`);
