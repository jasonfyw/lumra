/**
 * End-to-end outbox → queue → media.uploaded against local Supabase (T12 × T10 contract):
 * a `job_outbox` row written the way the web finalize writes it is claimed by the relay,
 * published as a valid queue message, and handled into `ready` media with variant rows.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queueMessageSchema, toOutboxRecord, type QueueMessage } from '@lumra/contracts';
import {
  createMediaPipelineRepository,
  createOutboxRepository,
  createSqlClient,
  pgArray,
} from '@lumra/db';
import { handleMediaUploaded } from '../src/handlers/media-uploaded';
import { silentLogger } from '../src/log';
import { relayOutbox } from '../src/outbox-relay';
import type { ProcessorClient } from '../src/processor-client';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
// Production (Hyperdrive) client settings: prepared statements, no startup statement_timeout,
// fetch_types off — so the array parameters in the repositories are exercised as deployed.
const sql = createSqlClient(DATABASE_URL, { max: 4, prepare: true, statementTimeoutMs: 0 });
const SHA = 'c'.repeat(64);

let ownerId: string;
const galleries: string[] = [];
const outboxIds: string[] = [];

beforeAll(async () => {
  ownerId = randomUUID();
  await sql`
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
    values (${ownerId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`${ownerId}@example.test`}, '{}', '{}')`;
});

afterAll(async () => {
  if (galleries.length)
    await sql`delete from public.galleries where id = any(${pgArray(galleries)}::uuid[])`;
  if (outboxIds.length)
    await sql`delete from public.job_outbox where id = any(${pgArray(outboxIds)}::uuid[])`;
  await sql`delete from public.billing_accounts where user_id = ${ownerId}`.catch(() => {});
  await sql`delete from public.profiles where id = ${ownerId}`.catch(() => {});
  await sql`delete from auth.users where id = ${ownerId}`.catch(() => {});
  await sql.end();
});

async function seedUploadedMedia() {
  const [g] = await sql<{ id: string }[]>`
    insert into public.galleries (owner_id, slug)
    values (${ownerId}, ${randomUUID().replaceAll('-', '').slice(0, 20)}) returning id`;
  galleries.push(g!.id);
  const mediaId = randomUUID();
  const originalKey = `originals/owner-123456/${g!.id}/${mediaId}/source`;
  await sql`
    insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key,
                              status, checksum_sha256)
    values (${mediaId}, ${g!.id}, ${originalKey}, 'IMG_1.JPG', 'image/jpeg', 23, 'a0', 'uploaded', ${SHA})`;
  return { galleryId: g!.id, mediaId, originalKey };
}

/** Minimal JPEG prefix that passes the authoritative sniff (SOI + SOF0 4000×3000). */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xb8, 0x0f, 0xa0, 0x03, 0x01, 0x22, 0x00, 0x02,
  0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

function fakeProcessor(mediaId: string): ProcessorClient {
  return {
    async process(input) {
      await new Response(input.body).arrayBuffer();
      return {
        ok: true,
        manifest: {
          mediaId,
          source: {
            mime: 'image/jpeg',
            width: 4000,
            height: 3000,
            orientation: 1,
            takenAt: null,
            sha256: SHA,
          },
          encoding: { format: 'webp', quality: 80, pipelineVersion: 1 },
          variants: [
            {
              variant: 'w320',
              field: 'w320',
              mime: 'image/webp',
              width: 320,
              height: 240,
              byteSize: 3,
            },
          ],
        },
        files: [
          {
            variant: 'w320',
            field: 'w320',
            mime: 'image/webp',
            width: 320,
            height: 240,
            byteSize: 3,
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      };
    },
  };
}

async function relayOnly(predicate: (m: QueueMessage) => boolean) {
  const sent: QueueMessage[] = [];
  await relayOutbox(
    createOutboxRepository(sql),
    { sendBatch: async (batch) => void sent.push(...[...batch].map((b) => b.body)) },
    silentLogger,
  );
  return sent.filter(predicate);
}

describe('outbox → relay → media.uploaded', () => {
  it.each([
    [
      'legacy T10 payload (type + dedupeKey inside payload)',
      (mediaId: string) => ({
        eventName: 'media.uploaded',
        aggregateId: mediaId,
        payload: {
          type: 'media.uploaded',
          mediaId,
          traceId: 'req-t10',
          dedupeKey: `media.uploaded:${mediaId}`,
        },
        dedupeKey: `media.uploaded:${mediaId}`,
      }),
    ],
    [
      'toOutboxRecord()',
      (mediaId: string) =>
        toOutboxRecord(
          {
            type: 'media.uploaded',
            mediaId,
            traceId: 'req-t10',
            dedupeKey: `media.uploaded:${mediaId}`,
          },
          mediaId,
        ),
    ],
  ])('relays a row written as %s and processes it to ready', async (_name, build) => {
    const { galleryId, mediaId, originalKey } = await seedUploadedMedia();
    const record = build(mediaId);
    const [row] = await sql<{ id: string }[]>`
      insert into public.job_outbox (event_name, aggregate_id, payload, dedupe_key)
      values (${record.eventName}, ${record.aggregateId}, ${sql.json(record.payload as postgres.JSONValue)}, ${record.dedupeKey})
      on conflict (dedupe_key) do nothing
      returning id`;
    outboxIds.push(row!.id);

    const mine = await relayOnly((m) => m.type === 'media.uploaded' && m.mediaId === mediaId);
    expect(mine).toEqual([
      {
        type: 'media.uploaded',
        mediaId,
        traceId: 'req-t10',
        dedupeKey: `media.uploaded:${mediaId}`,
      },
    ]);
    expect(queueMessageSchema.safeParse(mine[0]).success).toBe(true);
    const [processed] = await sql`select processed_at from public.job_outbox where id = ${row!.id}`;
    expect(processed!.processed_at).not.toBeNull();

    const objects = new Map<string, Uint8Array>();
    const message = mine[0] as Extract<QueueMessage, { type: 'media.uploaded' }>;
    const outcome = await handleMediaUploaded(message, {
      repo: createMediaPipelineRepository(sql),
      originals: {
        async get(key, options) {
          if (key !== originalKey) return null;
          const bytes = options?.range ? JPEG.subarray(0, options.range.length) : JPEG;
          return {
            size: JPEG.length,
            body: new Blob([new Uint8Array(bytes)]).stream(),
            arrayBuffer: async () => new Uint8Array(bytes).buffer as ArrayBuffer,
          };
        },
      },
      derivatives: {
        put: async (key, value) => void objects.set(key, value),
        delete: async () => {},
      },
      processor: fakeProcessor(mediaId),
      log: silentLogger,
    });
    expect(outcome).toBe('ready');
    const [m] =
      await sql`select status, width, height, orientation from public.media where id = ${mediaId}`;
    expect(m).toEqual({ status: 'ready', width: 4000, height: 3000, orientation: 1 });
    const variants =
      await sql`select variant, object_key from public.media_variants where media_id = ${mediaId}`;
    expect(variants).toHaveLength(1);
    expect(objects.has(variants[0]!.object_key as string)).toBe(true);
    expect(
      (variants[0]!.object_key as string).startsWith(`derivatives/${galleryId}/${mediaId}/w320`),
    ).toBe(true);

    // Redelivery of the same message is a no-op.
    expect(
      await handleMediaUploaded(message, {
        repo: createMediaPipelineRepository(sql),
        originals: { get: async () => null },
        derivatives: { put: async () => {}, delete: async () => {} },
        processor: fakeProcessor(mediaId),
        log: silentLogger,
      }),
    ).toBe('already_ready');
  });

  it('relays media.delete rows as valid messages (handled by T13; unhandled types retry → DLQ)', async () => {
    const mediaId = randomUUID();
    const record = toOutboxRecord(
      { type: 'media.delete', mediaId, traceId: 'req-del', dedupeKey: `media.delete:${mediaId}` },
      mediaId,
    );
    const [row] = await sql<{ id: string }[]>`
      insert into public.job_outbox (event_name, aggregate_id, payload, dedupe_key)
      values (${record.eventName}, ${record.aggregateId}, ${sql.json(record.payload as postgres.JSONValue)}, ${record.dedupeKey})
      returning id`;
    outboxIds.push(row!.id);
    const mine = await relayOnly((m) => m.type === 'media.delete' && m.mediaId === mediaId);
    expect(mine).toEqual([
      { type: 'media.delete', mediaId, traceId: 'req-del', dedupeKey: `media.delete:${mediaId}` },
    ]);
  });
});
