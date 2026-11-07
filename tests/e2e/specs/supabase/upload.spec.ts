import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { SUPABASE_E2E } from './env';
import { FakeS3 } from './fake-s3';

/**
 * T14 upload recovery against the real route handlers + local Postgres, with R2 replaced by the
 * fake S3 server (`R2_ENDPOINT`). Run with E2E_SUPABASE=1 (see playwright.config.ts).
 */
const sql = postgres(SUPABASE_E2E.databaseUrl, { max: 2, onnotice: () => {}, prepare: false });
const s3 = new FakeS3();
test.describe.configure({ mode: 'serial', timeout: 90_000 });
test.beforeAll(() => s3.start());
test.afterAll(async () => {
  await s3.stop();
  await sql.end();
});

test.beforeEach(async ({ context }) => {
  const ip = `198.19.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': ip });
});

const MIB = 1024 * 1024;
const JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22,
  0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
]);

/** A JPEG-headed file on disk (stable `lastModified`, so a reselect matches after reload). */
function jpegOnDisk(name: string, size: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'lumra-e2e-'));
  const path = join(dir, name);
  const body = Buffer.alloc(size);
  JPEG_HEADER.copy(body);
  randomBytes(4096).copy(body, 1024); // not all zeros
  writeFileSync(path, body);
  return path;
}

async function openNew(page: Page): Promise<string> {
  await page.goto('/new');
  await expect(page.getByRole('button', { name: 'Choose photos' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible(); // draft exists
  const [row] = await sql<{ id: string }[]>`
    select g.id from galleries g join guest_sessions s on s.id = g.guest_session_id
    order by g.created_at desc limit 1`;
  return row!.id;
}

async function throttle(page: Page, bytesPerSecond: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 40,
    downloadThroughput: bytesPerSecond,
    uploadThroughput: bytesPerSecond,
  });
}

test('a throttled multipart upload recovers from a failed part', async ({ page }) => {
  const galleryId = await openNew(page);
  await throttle(page, 4 * MIB);
  s3.failPuts.set(2, 1);
  s3.log.length = 0;

  await page.getByTestId('upload-input').setInputFiles(jpegOnDisk('throttled.jpg', 20 * MIB));
  const tile = page.getByRole('listitem').filter({ hasText: 'throttled.jpg' });
  await expect(tile).toContainText('Uploading');
  await expect(tile).toContainText('Uploaded · processing soon', { timeout: 60_000 });

  expect(s3.log.filter((l) => l === 'PUT part 2')).toHaveLength(2); // failed once, retried
  const media = await sql<{ status: string; size: string }[]>`
    select status, byte_size::text as size from media where gallery_id = ${galleryId}`;
  expect(media).toEqual([{ status: 'uploaded', size: String(20 * MIB) }]);
  await expect(page.getByTestId('upload-announcer')).toContainText('uploaded', { timeout: 10_000 });
});

test('after a reload, reselecting the file resumes without re-sending finished parts', async ({
  page,
}) => {
  await openNew(page);
  await throttle(page, 3 * MIB);
  s3.log.length = 0;
  const path = jpegOnDisk('resume.jpg', 20 * MIB);
  await page.getByTestId('upload-input').setInputFiles(path);
  await expect
    .poll(() => s3.log.filter((l) => l === 'PUT part 1').length, { timeout: 30_000 })
    .toBe(1);
  await expect.poll(() => s3.log.includes('PUT part 2'), { timeout: 30_000 }).toBe(true);

  page.on('dialog', (d) => void d.accept()); // beforeunload warning
  await page.reload();
  await expect(page.getByText('1 upload was interrupted.')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'resume.jpg' })).toContainText(
    'Paused',
  );

  const before = s3.log.length;
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose files to resume' }).click();
  await (await chooser).setFiles(path);
  await expect(page.getByRole('listitem').filter({ hasText: 'resume.jpg' })).toContainText(
    'Uploaded · processing soon',
    { timeout: 60_000 },
  );
  expect(s3.log.slice(before)).not.toContain('PUT part 1');
});
