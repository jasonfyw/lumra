import 'server-only';
import { createR2Client, type R2Client } from '@lumra/media';
import { requireEnv, serverEnv } from './env';

let originals: R2Client | undefined;

/**
 * R2 client for the private originals bucket, using the presign-scoped credentials (T09). Built
 * lazily so builds and routes that never touch R2 need no credentials; a missing variable fails
 * the request with a logged `ConfigurationError` (generic 500 to the client).
 */
export function getOriginalsBucket(): R2Client {
  originals ??= createR2Client({
    accountId: requireEnv('R2_ACCOUNT_ID'),
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    bucket: serverEnv().R2_BUCKET_ORIGINALS,
    endpoint: serverEnv().R2_ENDPOINT?.replace(/\/+$/, ''),
  });
  return originals;
}
