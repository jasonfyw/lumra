import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { SUPABASE_E2E } from './env';

/**
 * T15/T16/T21 editor journey against the local Supabase stack (E2E_SUPABASE=1):
 * sign in → new gallery → rename → publish → copy link (+ QR) → delete.
 */
const sql = postgres(SUPABASE_E2E.databaseUrl, { max: 2, onnotice: () => {}, prepare: false });
test.afterAll(() => sql.end());

test.beforeEach(async ({ context }) => {
  const ip = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': ip });
});

async function otpFor(email: string): Promise<string> {
  const query = encodeURIComponent(`to:"${email}"`);
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await fetch(`${SUPABASE_E2E.mailpitUrl}/api/v1/search?query=${query}`);
    const { messages } = (await res.json()) as { messages: { ID: string }[] };
    if (messages?.length) {
      const msg = await fetch(`${SUPABASE_E2E.mailpitUrl}/api/v1/message/${messages[0]!.ID}`);
      const { Text } = (await msg.json()) as { Text: string };
      const code = Text.match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('sign-in email not received');
}

async function signIn(page: Page) {
  const email = `e2e-${randomUUID()}@example.test`;
  await page.goto('/auth?returnTo=%2Fdashboard');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('6-digit code').fill(await otpFor(email));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('create → rename → publish → copy link → delete', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  await signIn(page);

  await page.getByRole('button', { name: 'New gallery' }).click();
  await expect(page).toHaveURL(/\/dashboard\/galleries\/[0-9a-f-]{36}$/);
  const galleryId = page.url().split('/').pop()!;
  const [{ slug } = { slug: '' }] = await sql<{ slug: string }[]>`
    select slug from public.galleries where id = ${galleryId}`;

  // Rename inline; the slug (share URL) stays the same.
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Gallery title').fill('Lisbon weekend');
  await page.getByLabel('Gallery title').press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Lisbon weekend' })).toBeVisible();

  // Publish with no photos: the link is available immediately.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const shareUrl = new URL(`/g/${slug}`, baseURL).toString();
  await expect(page.getByLabel('Share link')).toHaveValue(shareUrl);
  await expect(page.getByRole('img', { name: `QR code for ${shareUrl}` })).toBeVisible();

  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Link copied.' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shareUrl);

  const [row] = await sql<{ status: string; title: string; slug: string }[]>`
    select status, title, slug from public.galleries where id = ${galleryId}`;
  expect(row).toEqual({ status: 'published', title: 'Lisbon weekend', slug });

  // Irreversible delete behind a typed confirmation.
  await page.getByRole('button', { name: 'Delete gallery…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
  await dialog.getByLabel(/Type “delete”/).fill('delete');
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const [deleted] = await sql<{ status: string }[]>`
    select status from public.galleries where id = ${galleryId}`;
  expect(deleted!.status).toBe('deleted');
  expect((await page.goto(`/dashboard/galleries/${galleryId}`))?.status()).toBe(404);
});
