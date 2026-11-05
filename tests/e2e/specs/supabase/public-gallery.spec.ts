import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { argon2id } from 'hash-wasm';
import postgres from 'postgres';
import { SUPABASE_E2E } from './env';

/**
 * Recipient `/g/[slug]` against the local Supabase stack (T16/T19/T20; E2E_SUPABASE=1).
 * Galleries are seeded directly in Postgres. Media URLs point at a gateway origin that is never
 * contacted, so specs assert tiles, statuses and gateway URLs rather than pixels.
 */
const sql = postgres(SUPABASE_E2E.databaseUrl, { max: 2, onnotice: () => {}, prepare: false });
const users: string[] = [];

test.afterAll(async () => {
  if (users.length) {
    await sql`delete from public.galleries where owner_id = any(${users}::uuid[])`;
    await sql`delete from auth.users where id = any(${users}::uuid[])`;
  }
  await sql.end();
});

test.beforeEach(async ({ context }) => {
  const ip = `198.19.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': ip });
});

async function seedGallery(opts: { password?: string; expiresAt?: Date; title?: string } = {}) {
  const ownerId = randomUUID();
  users.push(ownerId);
  await sql`
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
    values (${ownerId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            ${`${ownerId}@example.test`}, '{}', '{}')`;
  const slug = randomUUID().replaceAll('-', '').slice(0, 17);
  const passwordHash = opts.password
    ? await argon2id({
        password: opts.password,
        salt: randomBytes(16),
        parallelism: 1,
        iterations: 2,
        memorySize: 19_456,
        hashLength: 32,
        outputType: 'encoded',
      })
    : null;
  const [g] = await sql<{ id: string }[]>`
    insert into public.galleries (owner_id, slug, title, status, published_at, expires_at, password_hash)
    values (${ownerId}, ${slug}, ${opts.title ?? 'Coastline'}, 'published', now(),
            ${opts.expiresAt ?? null}, ${passwordHash})
    returning id`;
  return { id: g!.id, slug, ownerId };
}

async function addMedia(
  g: { id: string; ownerId: string },
  n: number,
  status: 'ready' | 'processing',
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into public.media (id, gallery_id, original_key, filename, mime, byte_size, sort_key,
                              status, width, height, ready_at)
    values (${id}, ${g.id}, ${`originals/${g.ownerId}/${g.id}/${id}/source`}, ${`IMG_${n}.jpg`},
            'image/jpeg', 1000, ${`a${String(n).padStart(4, '0')}`}, ${status},
            ${status === 'ready' ? 3000 : null}, ${status === 'ready' ? 2000 : null},
            ${status === 'ready' ? new Date() : null})`;
  if (status === 'ready') await addVariants(g.id, id);
  return id;
}

async function addVariants(galleryId: string, mediaId: string) {
  for (const w of [320, 640, 1280]) {
    await sql`
      insert into public.media_variants (media_id, variant, object_key, mime, width, height, byte_size)
      values (${mediaId}, ${`w${w}`}, ${`derivatives/${galleryId}/${mediaId}/w${w}e2e0001.webp`},
              'image/webp', ${w}, ${Math.round((w * 2) / 3)}, 100)
      on conflict do nothing`;
  }
}

test('published gallery renders hero and grid with gateway URLs; pending tiles fill in', async ({
  page,
}) => {
  const g = await seedGallery({ title: 'Coastline' });
  for (let n = 1; n <= 6; n++) await addMedia(g, n, 'ready');
  const late = await addMedia(g, 7, 'processing');

  const res = await page.goto(`/g/${g.slug}`);
  expect(res?.status()).toBe(200);
  expect(res?.headers()['cache-control']).toContain('no-store');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Coastline');

  const tiles = page.locator('[data-gallery-tile]');
  await expect(tiles).toHaveCount(7);
  const firstImg = tiles.first().locator('img');
  await expect(firstImg).toHaveAttribute('src', /^https:\/\/media\.lumra\.invalid\/m\//);
  await expect(tiles.nth(6)).toHaveAttribute('data-status', 'pending');

  // The processing item becomes ready; the poll picks it up without a reload (§14.2-3).
  await sql`update public.media set status = 'ready', width = 3000, height = 2000, ready_at = now()
            where id = ${late}`;
  await addVariants(g.id, late);
  await expect(tiles.nth(6)).toHaveAttribute('data-status', 'ready', { timeout: 20_000 });
  await expect(tiles.nth(6).locator('img')).toHaveAttribute('src', /media\.lumra\.invalid\/m\//, {
    timeout: 10_000,
  });

  // Lightbox mints a download URL on demand.
  await tiles.first().click();
  await expect(page.getByRole('link', { name: 'Download original' })).toHaveAttribute(
    'href',
    /media\.lumra\.invalid\/m\//,
  );
});

test('password gate → unlock → grid; wrong password is announced', async ({ page }) => {
  const g = await seedGallery({ password: 'sea breeze', title: 'Private Shoot' });
  await addMedia(g, 1, 'ready');

  await page.goto(`/g/${g.slug}`);
  await expect(
    page.getByRole('heading', { name: 'This gallery is password protected' }),
  ).toBeVisible();
  await expect(page.getByText('Private Shoot')).toHaveCount(0);
  await expect(page.locator('[data-gallery-tile]')).toHaveCount(0);

  const field = page.getByLabel('Password');
  await field.fill('wrong');
  await page.getByRole('button', { name: 'View gallery' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(/not correct/);

  await field.fill('sea breeze');
  await page.getByRole('button', { name: 'View gallery' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Private Shoot');
  await expect(page.locator('[data-gallery-tile]')).toHaveCount(1);

  // A password change (access_version bump) locks the gallery again.
  await sql`update public.galleries set access_version = access_version + 1 where id = ${g.id}`;
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'This gallery is password protected' }),
  ).toBeVisible();
});

test('expired and unknown galleries show consistent pages', async ({ page }) => {
  const g = await seedGallery({ expiresAt: new Date(Date.now() - 60_000) });
  await addMedia(g, 1, 'ready');
  await page.goto(`/g/${g.slug}`);
  await expect(page.getByRole('heading', { name: 'This gallery has expired' })).toBeVisible();
  await expect(page.locator('[data-gallery-tile]')).toHaveCount(0);

  const missing = await page.goto('/g/doesnotexist12345');
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Gallery not found' })).toBeVisible();
});
