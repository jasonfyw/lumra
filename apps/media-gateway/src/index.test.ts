import { describe, expect, it } from 'vitest';
import worker, { type Env } from './index';

const env = { APP_ORIGIN: 'http://localhost:3000' } as Env;
const call = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://media.example.test${path}`, init), env);

describe('media gateway', () => {
  it('reports health', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
  });

  it('fails closed for media paths without a valid token', async () => {
    const res = await call('/m/originals/some/guessed/key');
    expect(res.status).toBe(401);
  });

  it('rejects mutating methods', async () => {
    const res = await call('/m/x', { method: 'PUT' });
    expect(res.status).toBe(405);
  });
});
