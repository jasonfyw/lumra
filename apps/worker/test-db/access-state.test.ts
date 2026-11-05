/**
 * KV access-state writer against local Supabase (T20): the real repository reads the gallery
 * (and its owner's billing row) and the handler writes the gateway's document to a fake KV.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { galleryAccessStateSchema, queueMessageSchema } from '@lumra/contracts';
import { createAccessStateRepository } from '@lumra/db';
import { reconcileAccessStates, syncGalleryAccessState } from '../src/handlers/access-state';
import { silentLogger } from '../src/log';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const sql = postgres(DATABASE_URL, { max: 4, prepare: false, onnotice: () => {} });

let ownerId: string;
const galleries: string[] = [];

class FakeKv {
  readonly data = new Map<string, string>();
  async put(key: string, value: string) {
    this.data.set(key, value);
  }
  doc(id: string) {
    const raw = this.data.get(`gallery:${id}`);
    return raw === undefined ? undefined : galleryAccessStateSchema.parse(JSON.parse(raw));
  }
}

beforeAll(async () => {
  ownerId = randomUUID();
  await sql`
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
    values (${ownerId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`${ownerId}@example.test`}, '{}', '{}')`;
});

afterAll(async () => {
  if (galleries.length)
    await sql`delete from public.galleries where id = any(${galleries}::uuid[])`;
  await sql`delete from public.billing_accounts where user_id = ${ownerId}`.catch(() => {});
  await sql`delete from auth.users where id = ${ownerId}`.catch(() => {});
  await sql.end();
});

async function seedGallery(status: 'draft' | 'published') {
  const [g] = await sql<{ id: string }[]>`
    insert into public.galleries (owner_id, slug, status, published_at)
    values (${ownerId}, ${randomUUID().replaceAll('-', '').slice(0, 20)}, ${status},
            ${status === 'published' ? new Date() : null})
    returning id`;
  galleries.push(g!.id);
  return g!.id;
}

describe('gallery access state sync (db)', () => {
  it('follows publish → password change → expiry → delete', async () => {
    const kv = new FakeKv();
    const deps = { repo: createAccessStateRepository(sql), kv, log: silentLogger };
    const id = await seedGallery('draft');
    expect(await syncGalleryAccessState(id, deps)).toBe('skipped_draft');

    await sql`update public.galleries set status = 'published', published_at = now() where id = ${id}`;
    expect(await syncGalleryAccessState(id, deps)).toBe('written');
    expect(kv.doc(id)).toMatchObject({
      accessVersion: 1,
      deleted: false,
      deliverySuspended: false,
    });

    const expiresAt = new Date(Date.now() + 3_600_000);
    await sql`update public.galleries set access_version = 2, expires_at = ${expiresAt} where id = ${id}`;
    await syncGalleryAccessState(id, deps);
    expect(kv.doc(id)).toMatchObject({ accessVersion: 2, expiresAt: expiresAt.toISOString() });

    await sql`update public.billing_accounts set status = 'past_due',
              past_due_since = now() - interval '30 days' where user_id = ${ownerId}`;
    await syncGalleryAccessState(id, deps);
    expect(kv.doc(id)?.deliverySuspended).toBe(true);
    await sql`update public.billing_accounts set status = 'free', past_due_since = null
              where user_id = ${ownerId}`;

    await sql`update public.galleries set status = 'deleted', deleted_at = now() where id = ${id}`;
    expect(await syncGalleryAccessState(id, deps)).toBe('tombstoned');
    expect(kv.doc(id)?.deleted).toBe(true);
  });

  it('reconcile rewrites every published gallery', async () => {
    const kv = new FakeKv();
    const a = await seedGallery('published');
    const b = await seedGallery('published');
    const draft = await seedGallery('draft');
    await reconcileAccessStates(
      { repo: createAccessStateRepository(sql), kv, log: silentLogger },
      { batchSize: 50 },
    );
    expect(kv.doc(a)?.deleted).toBe(false);
    expect(kv.doc(b)?.deleted).toBe(false);
    expect(kv.doc(draft)).toBeUndefined();
  });

  it('the web outbox payload is a valid queue message', () => {
    const galleryId = randomUUID();
    const payload = {
      type: 'gallery.access_changed',
      galleryId,
      traceId: 'req-1',
      dedupeKey: `gallery.access_changed:${galleryId}:${randomUUID()}`,
    };
    expect(queueMessageSchema.safeParse(payload).success).toBe(true);
  });
});
