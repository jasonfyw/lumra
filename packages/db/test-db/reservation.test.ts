/**
 * public.reserve_guest_upload (FR-A02, PRD §11): atomic guest quota reservation under real
 * concurrency. Fixtures are committed (parallel connections must see them) and removed afterwards.
 */
import { randomUUID } from 'node:crypto';
import { GUEST_LIMITS } from '@lumra/config';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { actAs, connect, createUser, DENIED, expectSqlError, inRollback } from './helpers';

const sql = connect(30);
const created: string[] = [];

afterEach(async () => {
  if (created.length)
    await sql`delete from public.guest_sessions where id in ${sql(created.splice(0))}`;
});
afterAll(() => sql.end());

async function newGuestSession(expiresIn = '24 hours'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into public.guest_sessions (capability_hash, expires_at)
    values (${randomUUID()}, now() + ${expiresIn}::interval) returning id`;
  created.push(row!.id);
  return row!.id;
}

/** One reservation as the service role, in its own transaction/connection. */
function reserve(guestSessionId: string, bytes: number): Promise<boolean> {
  return sql.begin(async (tx) => {
    await actAs(tx, 'service_role');
    const [row] = await tx<{ ok: boolean }[]>`
      select public.reserve_guest_upload(${guestSessionId}::uuid, ${bytes}::bigint) as ok`;
    return row!.ok;
  });
}

async function usage(id: string) {
  const [row] = await sql<{ files: number; bytes: string }[]>`
    select reserved_file_count as files, reserved_bytes::text as bytes
    from public.guest_sessions where id = ${id}`;
  return { files: row!.files, bytes: Number(row!.bytes) };
}

describe('reserve_guest_upload', () => {
  it(`21 concurrent reservations => exactly ${GUEST_LIMITS.maxFiles} succeed`, async () => {
    const id = await newGuestSession();
    const results = await Promise.all(Array.from({ length: 21 }, () => reserve(id, 1_000_000)));
    expect(results.filter(Boolean)).toHaveLength(GUEST_LIMITS.maxFiles);
    expect(await usage(id)).toEqual({ files: 20, bytes: 20_000_000 });
  });

  it('enforces the 250,000,000 byte cap under concurrency', async () => {
    const id = await newGuestSession();
    const results = await Promise.all(Array.from({ length: 5 }, () => reserve(id, 100_000_000)));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await usage(id)).toEqual({ files: 2, bytes: 200_000_000 });
    // Exactly filling the cap is allowed; one more byte is not.
    expect(await reserve(id, 50_000_000)).toBe(true);
    expect(await reserve(id, 1)).toBe(false);
    expect(await usage(id)).toEqual({ files: 3, bytes: GUEST_LIMITS.maxBytes });
  });

  it('rejects expired, claimed and unknown sessions and non-positive sizes', async () => {
    const expired = await newGuestSession('-1 second');
    expect(await reserve(expired, 1)).toBe(false);

    const claimed = await newGuestSession();
    await sql`update public.guest_sessions set claimed_at = now() where id = ${claimed}`;
    expect(await reserve(claimed, 1)).toBe(false);

    expect(await reserve(randomUUID(), 1)).toBe(false);

    const live = await newGuestSession();
    expect(await reserve(live, 0)).toBe(false);
    expect(await reserve(live, -5)).toBe(false);
    expect(await usage(live)).toEqual({ files: 0, bytes: 0 });
  });

  it('is executable only by service_role', async () => {
    await inRollback(sql, async (tx) => {
      const user = await createUser(tx);
      const [gs] = await tx<{ id: string }[]>`
        insert into public.guest_sessions (capability_hash, expires_at)
        values (${randomUUID()}, now() + interval '1 hour') returning id`;
      for (const [role, uid] of [
        ['anon', undefined],
        ['authenticated', user],
      ] as const) {
        await actAs(tx, role, uid);
        await expectSqlError(
          tx,
          DENIED,
          (sp) => sp`select public.reserve_guest_upload(${gs!.id}::uuid, 1::bigint)`,
        );
      }
    });
  });
});
