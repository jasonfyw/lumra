/**
 * Helpers for DB integration tests against the local Supabase stack (`pnpm test:db`).
 * Connects as `postgres` and impersonates PostgREST roles with SET LOCAL ROLE + request.jwt.claims,
 * which is exactly how Supabase evaluates RLS for browser clients.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { expect } from 'vitest';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export function connect(max = 5) {
  return postgres(DATABASE_URL, { max, onnotice: () => {}, prepare: false });
}

export type Sql = ReturnType<typeof connect>;
export type Tx = postgres.TransactionSql;
export type Role = 'anon' | 'authenticated' | 'service_role';

const ROLLBACK = Symbol('rollback');

/** Runs `fn` in a transaction that is always rolled back, so fixtures never leak between tests. */
export async function inRollback(sql: Sql, fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

/** Switch the current transaction to a PostgREST role, optionally as a signed-in user. */
export async function actAs(tx: Tx, role: Role | 'postgres', userId?: string): Promise<void> {
  if (role === 'postgres') {
    await tx`reset role`;
    await tx`select set_config('request.jwt.claims', '', true)`;
    return;
  }
  const claims = JSON.stringify(userId ? { sub: userId, role } : { role });
  await tx`select set_config('request.jwt.claims', ${claims}, true)`;
  await tx`select set_config('role', ${role}, true)`;
}

/** Asserts that `fn` fails with the given SQLSTATE, isolated in a savepoint. */
export async function expectSqlError(
  tx: Tx,
  code: string,
  fn: (sp: Tx) => Promise<unknown>,
): Promise<void> {
  await expect(tx.savepoint((sp) => fn(sp))).rejects.toMatchObject({ code });
}

/** 42501 insufficient_privilege */
export const DENIED = '42501';
/** 23514 check_violation */
export const CHECK_VIOLATION = '23514';
/** 23505 unique_violation */
export const UNIQUE_VIOLATION = '23505';

/** Creates an auth user as postgres; handle_new_user provisions profile + billing account. */
export async function createUser(tx: Tx | Sql, email?: string): Promise<string> {
  const id = randomUUID();
  await tx`
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
    values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${email ?? `${id}@example.test`}, '{}', '{}')`;
  return id;
}

export function slug(): string {
  return randomUUID().replaceAll('-', '').slice(0, 20);
}

export async function createGallery(
  tx: Tx,
  ownerId: string,
  extra: { deleted?: boolean } = {},
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into public.galleries (owner_id, slug, status, deleted_at)
    values (${ownerId}, ${slug()}, ${extra.deleted ? 'deleted' : 'draft'},
            ${extra.deleted ? new Date() : null})
    returning id`;
  return row!.id;
}

export async function createMedia(
  tx: Tx,
  galleryId: string,
  extra: { deleted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await tx`
    insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key, status, deleted_at)
    values (${id}, ${galleryId}, ${`originals/test/${galleryId}/${id}/source`}, 'photo.jpg', 'image/jpeg',
            1000, ${'a' + id.slice(0, 4)}, ${extra.deleted ? 'deleting' : 'reserved'},
            ${extra.deleted ? new Date() : null})`;
  await tx`
    insert into public.media_variants (media_id, variant, object_key, mime, width, height, byte_size)
    values (${id}, 'w320', ${`derivatives/${galleryId}/${id}/w320.webp`}, 'image/webp', 320, 240, 100)`;
  return id;
}
