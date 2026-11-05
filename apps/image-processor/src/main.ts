import sharp from 'sharp';
import { imageProcessorEnvSchema, parseEnv } from '@lumra/config';
import { createServer } from './server';

const env = parseEnv('image-processor', imageProcessorEnvSchema, process.env);
const server = createServer();

server.listen(env.PORT, () => {
  console.info(
    JSON.stringify({
      level: 'info',
      msg: 'listening',
      service: 'image-processor',
      port: env.PORT,
      vips: sharp.versions.vips,
      heifSuffixes: sharp.format.heif.input.fileSuffix ?? [],
    }),
  );
});

// Cloudflare Containers send SIGTERM before stopping an instance; finish in-flight work first.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
