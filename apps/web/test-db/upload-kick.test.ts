/**
 * Finalize → worker relay kick: after `completeUpload` commits, the web app schedules a
 * best-effort `POST {WORKER_URL}/internal/relay` (via Next's `after()`). The kick never affects
 * the response: when it fails, finalize still succeeds and the outbox row is still written.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as createIntent } from '@/app/api/v1/galleries/[id]/upload-intents/route';
import { POST as signParts } from '@/app/api/v1/uploads/[id]/parts/sign/route';
import { POST as complete } from '@/app/api/v1/uploads/[id]/complete/route';
import { getPrincipals } from '@/lib/actor';
import { getDb } from '@/lib/db';
import { resetServerEnvForTests } from '@/lib/env';
import { createLogger } from '@lumra/observability';
import { getOriginalsBucket } from '@/lib/r2';
import { completeUpload } from '@/server/uploads';
import { actAs, cleanup, jsonRequest, newDraft, params, readJson, sql, state } from './helpers';

const afterCallbacks = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  after: (fn: () => unknown) => void afterCallbacks.push(fn),
}));

const WORKER_URL = 'https://worker.lumra.test';
const SECRET = 'kick-secret-0123456789abcdef0123456789abcdef';
const r2 = state.r2;
const r2Fetch = globalThis.fetch;
let workerCalls: Request[] = [];
let workerResponse: () => Promise<Response> = async () => new Response(null, { status: 202 });

beforeEach(() => {
  r2.reset();
  afterCallbacks.length = 0;
  workerCalls = [];
  workerResponse = async () => new Response(null, { status: 202 });
  process.env.WORKER_URL = WORKER_URL;
  process.env.WORKER_KICK_SECRET = SECRET;
  resetServerEnvForTests();
  // Route worker requests to a recorder; everything else still hits the R2 fake.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.startsWith(WORKER_URL)) {
      workerCalls.push(request);
      return workerResponse();
    }
    return r2Fetch(input, init);
  });
});
afterEach(async () => {
  vi.stubGlobal('fetch', r2Fetch);
  delete process.env.WORKER_URL;
  delete process.env.WORKER_KICK_SECRET;
  resetServerEnvForTests();
  await cleanup();
});
afterAll(() => sql.end());

/** A guest draft with one single-PUT upload whose bytes are in R2, ready to complete. */
async function uploadedIntent() {
  const draft = await newDraft();
  actAs({ guestCookie: draft.capability });
  const galleryId = draft.body.data.galleryId as string;
  const size = 2_000_000;
  const res = await createIntent(
    jsonRequest(`/api/v1/galleries/${galleryId}/upload-intents`, {
      filename: 'IMG_0001.JPG',
      mime: 'image/jpeg',
      size,
      clientId: randomUUID(),
    }),
    params(galleryId),
  );
  const { intentId, mediaId } = (await readJson<{ intentId: string; mediaId: string }>(res)).data;
  const signed = await signParts(
    jsonRequest(`/api/v1/uploads/${intentId}/parts/sign`, { partNumbers: [1] }),
    params(intentId),
  );
  const part = (
    await readJson<{ parts: { url: string; headers: Record<string, string> }[] }>(signed)
  ).data.parts[0]!;
  expect(r2.browserPut(part, size).status).toBe(200);
  return { intentId, mediaId };
}

async function outboxCount(mediaId: string) {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from public.job_outbox
    where aggregate_id = ${mediaId} and event_name = 'media.uploaded'`;
  return row!.count;
}

const silent = createLogger({ service: 'web', sink: () => {} });

describe('finalize kick', () => {
  it('schedules one authenticated relay kick after the commit (route level)', async () => {
    const { intentId, mediaId } = await uploadedIntent();
    const res = await complete(
      jsonRequest(`/api/v1/uploads/${intentId}/complete`, {}),
      params(intentId),
    );
    expect(res.status).toBe(200);
    // Nothing is sent before the response; `after()` runs it afterwards.
    expect(workerCalls).toHaveLength(0);
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]!();
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]!.method).toBe('POST');
    expect(workerCalls[0]!.url).toBe(`${WORKER_URL}/internal/relay`);
    expect(workerCalls[0]!.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(await outboxCount(mediaId)).toBe(1);
  });

  it('still succeeds when the worker kick fails', async () => {
    const { intentId, mediaId } = await uploadedIntent();
    workerResponse = async () => {
      throw new TypeError('fetch failed');
    };
    const res = await complete(
      jsonRequest(`/api/v1/uploads/${intentId}/complete`, {}),
      params(intentId),
    );
    expect(res.status).toBe(200);
    await expect(afterCallbacks[0]!()).resolves.toBeUndefined();
    expect(workerCalls).toHaveLength(1);
    expect(await outboxCount(mediaId)).toBe(1);
  });

  it('skips the kick when WORKER_URL / WORKER_KICK_SECRET are unset', async () => {
    delete process.env.WORKER_URL;
    resetServerEnvForTests();
    const { intentId } = await uploadedIntent();
    const res = await complete(
      jsonRequest(`/api/v1/uploads/${intentId}/complete`, {}),
      params(intentId),
    );
    expect(res.status).toBe(200);
    expect(afterCallbacks).toHaveLength(0);
  });

  it('completeUpload calls kickRelay after commit and survives a throwing kick', async () => {
    const { intentId, mediaId } = await uploadedIntent();
    const principals = await getPrincipals();
    const kickRelay = vi.fn(() => {
      // The kick must only be scheduled once the outbox row is committed.
      throw new Error('scheduler exploded');
    });
    const result = await completeUpload(
      { db: getDb(), r2: getOriginalsBucket, log: silent, requestId: 'req-kick', kickRelay },
      principals,
      intentId,
      { parts: [] },
    );
    expect(result).toMatchObject({ status: 'completed', mediaStatus: 'uploaded' });
    expect(kickRelay).toHaveBeenCalledOnce();
    expect(await outboxCount(mediaId)).toBe(1);
  });
});
