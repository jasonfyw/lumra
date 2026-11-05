import 'server-only';
import { argon2id, argon2Verify } from 'hash-wasm';

/**
 * Gallery password hashing (FR-G04): Argon2id with OWASP's minimum profile (19 MiB, t=2, p=1),
 * encoded as a PHC string so parameters can be raised later without a migration. hash-wasm is
 * pure WebAssembly, so it runs on Vercel without native binaries. Plaintext is never stored or
 * logged.
 */
const PARAMS = { parallelism: 1, iterations: 2, memorySize: 19_456, hashLength: 32 } as const;

export async function hashGalleryPassword(password: string): Promise<string> {
  return argon2id({
    ...PARAMS,
    password: password.normalize('NFC'),
    salt: crypto.getRandomValues(new Uint8Array(16)),
    outputType: 'encoded',
  });
}

export async function verifyGalleryPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: password.normalize('NFC'), hash });
  } catch {
    return false; // malformed hash → deny
  }
}
