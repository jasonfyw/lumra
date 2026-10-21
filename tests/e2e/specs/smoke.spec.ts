import { expect, test } from '@playwright/test';

test('landing page offers the primary CTA', async ({ page }) => {
  await page.goto('/');
  const cta = page.getByRole('link', { name: 'Create gallery' });
  await expect(cta).toBeVisible();
  const box = await cta.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44); // touch target (PRD §4)
});

test('health probe is sanitized', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.data).toEqual({ status: 'ok' });
});
