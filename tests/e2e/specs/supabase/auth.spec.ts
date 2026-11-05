import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { SUPABASE_E2E } from './env';

/**
 * T05/T07/T08 against the local Supabase stack (run with E2E_SUPABASE=1). Emails are read from
 * Mailpit's API; guest drafts are seeded directly in Postgres (the guest-draft endpoint is T06).
 */
const sql = postgres(SUPABASE_E2E.databaseUrl, { max: 2, onnotice: () => {}, prepare: false });
test.afterAll(() => sql.end());

// Each test looks like a different client IP, so the per-IP auth rate limits (RATE_LIMITS
// authOtp*) don't accumulate across tests and repeated runs.
test.beforeEach(async ({ context }) => {
  const ip = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': ip });
});

const uniqueEmail = () => `e2e-${randomUUID()}@example.test`;

interface MailpitMessage {
  Text: string;
  HTML: string;
}

async function latestEmail(email: string): Promise<MailpitMessage> {
  const query = encodeURIComponent(`to:"${email}"`);
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await fetch(`${SUPABASE_E2E.mailpitUrl}/api/v1/search?query=${query}`);
    const { messages } = (await res.json()) as { messages: { ID: string }[] };
    if (messages?.length) {
      const msg = await fetch(`${SUPABASE_E2E.mailpitUrl}/api/v1/message/${messages[0]!.ID}`);
      return (await msg.json()) as MailpitMessage;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('sign-in email not received');
}

async function otpFor(email: string): Promise<string> {
  const { Text } = await latestEmail(email);
  const code = Text.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error('no 6-digit code in email');
  return code;
}

async function requestCode(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('We sent a 6-digit code');
}

async function signInWithCode(page: Page, email: string) {
  await requestCode(page, email);
  await page.getByLabel('6-digit code').fill(await otpFor(email));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** A guest session + draft, and the capability cookie value that proves it. */
async function seedGuestDraft() {
  const capability = randomBytes(32).toString('base64url');
  const hash = createHmac('sha256', SUPABASE_E2E.guestPepper).update(capability).digest('hex');
  const [session] = await sql<{ id: string }[]>`
    insert into public.guest_sessions (capability_hash, expires_at)
    values (${hash}, now() + interval '24 hours') returning id`;
  const [gallery] = await sql<{ id: string }[]>`
    insert into public.galleries (guest_session_id, slug, title)
    values (${session!.id}, ${randomUUID().replaceAll('-', '').slice(0, 20)}, 'Guest trip')
    returning id`;
  return { capability, galleryId: gallery!.id };
}

test('dashboard is auth-gated', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/auth\?returnTo=%2Fdashboard$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('OTP sign-in, open-redirect guard, dashboard and new gallery', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/auth?returnTo=https%3A%2F%2Fevil.example%2F');
  await signInWithCode(page, email);

  // Foreign returnTo replaced by the dashboard; first sign-in provisions the account.
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'No galleries yet' })).toBeVisible();

  await page.getByRole('button', { name: 'New gallery' }).click();
  await expect(page).toHaveURL(/\/dashboard\/galleries\/[0-9a-f-]{36}$/);
  await page.goto('/dashboard');
  const row = page.getByRole('row', { name: /Untitled gallery/ });
  await expect(row).toContainText('Draft');
  await expect(row).toContainText('0 bytes');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/auth\?/);
});

test('wrong code shows an accessible error; resend is rate-limited in the UI', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/auth');
  await requestCode(page, email);
  await expect(page.getByRole('button', { name: /Resend code in \d+s/ })).toBeDisabled();
  const real = await otpFor(email);
  await page.getByLabel('6-digit code').fill(real === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toContainText(
    'incorrect or has expired',
  );
  await expect(page).toHaveURL(/\/auth/);
});

test('magic link signs in and returns to returnTo', async ({ page }) => {
  const email = uniqueEmail();
  await page.goto('/auth?returnTo=%2Fdashboard%3Fsrc%3Dlink');
  await requestCode(page, email);
  const { HTML } = await latestEmail(email);
  const link = HTML.match(/href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  expect(link).toBeTruthy();
  await page.goto(link!);
  await expect(page).toHaveURL(/\/dashboard\?src=link$/);
});

test('invalid magic link lands on /auth with an accessible error', async ({ page }) => {
  await page.goto('/auth/confirm?token_hash=bogus&type=email&returnTo=%2Fdashboard');
  await expect(page).toHaveURL(/\/auth\?returnTo=%2Fdashboard&error=link_invalid/);
  await expect(page.getByRole('alert').filter({ hasText: /./ })).toContainText(
    'invalid or has expired',
  );
});

test('publish intent: sign-in in the same browser claims the guest draft', async ({
  page,
  context,
  baseURL,
}) => {
  const draft = await seedGuestDraft();
  await context.addCookies([
    {
      name: 'lumra_guest',
      value: draft.capability,
      url: baseURL!,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.goto(`/auth?returnTo=%2Fdashboard&intent=publish&galleryId=${draft.galleryId}`);
  await expect(page.getByRole('heading', { name: 'Sign in to publish' })).toBeVisible();
  await signInWithCode(page, uniqueEmail());

  // Claim step runs, then returns to returnTo; the draft is now in the account.
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('row', { name: /Guest trip/ })).toBeVisible();
  const [row] = await sql<{ owner_id: string | null; claimed_at: Date | null }[]>`
    select owner_id, claimed_at from public.galleries where id = ${draft.galleryId}`;
  expect(row!.owner_id).not.toBeNull();
  expect(row!.claimed_at).not.toBeNull();
  expect((await context.cookies()).some((c) => c.name === 'lumra_guest')).toBe(false);
});

test('interrupted auth: another browser without the guest cookie cannot claim', async ({
  browser,
}) => {
  const draft = await seedGuestDraft();
  const other = await browser.newContext({
    extraHTTPHeaders: { 'x-forwarded-for': `198.19.${randomBytes(1)[0]}.${randomBytes(1)[0]}` },
  });
  const page = await other.newPage();
  await page.goto(`/auth?returnTo=%2Fdashboard&intent=publish&galleryId=${draft.galleryId}`);
  await signInWithCode(page, uniqueEmail());

  await expect(
    page.getByText('Return to the browser where you started to finish publishing.'),
  ).toBeVisible();
  // Calling the API directly with only the draft id is refused (concealed 404).
  const res = await page.request.post('/api/v1/guest/drafts/claim', {
    data: { galleryId: draft.galleryId },
  });
  expect(res.status()).toBe(404);
  const [row] = await sql<{ owner_id: string | null }[]>`
    select owner_id from public.galleries where id = ${draft.galleryId}`;
  expect(row!.owner_id).toBeNull();
  await other.close();
});

test('token_hash magic link also signs in from a different browser (FR-A04)', async ({
  page,
  browser,
}) => {
  const email = uniqueEmail();
  await page.goto('/auth');
  await requestCode(page, email);
  const { HTML } = await latestEmail(email);
  const link = HTML.match(/href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  expect(link).toContain('token_hash=');
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto(link!);
  await expect(otherPage).toHaveURL(/\/dashboard$/);
  await expect(otherPage.getByRole('heading', { name: 'Galleries', exact: true })).toBeVisible();
  await other.close();
});
