import { expect, test } from '@playwright/test';

test('landing page offers the primary CTA', async ({ page }) => {
  await page.goto('/');
  const cta = page.getByRole('link', { name: 'Create gallery' });
  await expect(cta).toBeVisible();
  const box = await cta.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44); // touch target (PRD §4)
});

test('health probe is sanitized', async ({ request }) => {
  const res = await request.get('/api/health', { headers: { 'x-request-id': 'e2e-health-probe' } });
  expect(res.ok()).toBe(true);
  expect(res.headers()['x-request-id']).toBe('e2e-health-probe');
  const body = await res.json();
  // Only status, service and (on deployed builds) a short commit SHA — nothing else.
  const { commit, ...rest } = body.data;
  expect(rest).toEqual({ status: 'ok', service: 'web' });
  if (commit !== undefined) expect(commit).toMatch(/^[0-9a-f]{7,12}$/);
  expect(body.requestId).toBe('e2e-health-probe');
});
