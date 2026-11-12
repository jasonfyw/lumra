import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Archive progress page states (T25) against the dev-only fixture `/dev/archive`, which renders
 * the real `ArchiveProgress` component with polling off. Data wiring (status API, Download all)
 * is covered by the route and component tests. Set `E2E_SCREENSHOT_DIR` to save a screenshot of
 * every state per project.
 */
const shotDir = process.env.E2E_SCREENSHOT_DIR;

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

async function open(page: Page, state: string, parts = 1) {
  await page.goto(`/dev/archive?state=${state}&parts=${parts}`);
  await expect(page.locator(`[data-archive-status="${state}"]`)).toBeVisible();
}

async function shoot(page: Page, name: string) {
  if (!shotDir) return;
  await page.screenshot({
    path: `${shotDir}/${test.info().project.name}-${name}.png`,
    fullPage: true,
  });
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('archive progress page (fixture)', () => {
  test('preparing / processing show an accessible progress bar', async ({ page }) => {
    await open(page, 'preparing', 4);
    await expect(page.getByRole('heading', { name: 'Preparing your download' })).toBeVisible();
    await expect(page.getByText('4 parts')).toBeVisible();
    await shoot(page, 'preparing');

    await open(page, 'processing', 4);
    const bar = page.getByRole('progressbar', { name: 'Preparing download' });
    await expect(bar).toHaveAttribute('aria-valuenow', '46');
    await expect(page.getByText('46%')).toBeVisible();
    await noHorizontalScroll(page);
    expect(await seriousViolations(page)).toEqual([]);
    await shoot(page, 'processing');
  });

  test('ready lists one download link per part', async ({ page }) => {
    await open(page, 'ready', 4);
    await expect(
      page.getByRole('heading', { name: 'Your download is ready in 4 parts' }),
    ).toBeVisible();
    const links = page.getByRole('link', { name: /^Download Part \d of 4/ });
    await expect(links).toHaveCount(4);
    await expect(page.getByText('Original files, exactly as uploaded.')).toBeVisible();
    await noHorizontalScroll(page);
    expect(await seriousViolations(page)).toEqual([]);
    await shoot(page, 'ready');

    await open(page, 'ready', 1);
    await expect(page.getByRole('heading', { name: 'Your download is ready' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Download All photos/ })).toHaveCount(1);
    await shoot(page, 'ready-single');
  });

  test('failed offers Try again; expired offers a new download', async ({ page }) => {
    await open(page, 'failed');
    await expect(page.getByRole('alert')).toContainText('We couldn’t finish this download');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await shoot(page, 'failed');

    await open(page, 'expired', 2);
    await expect(page.getByRole('heading', { name: 'This download has expired' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Prepare a new download' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Download/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to the gallery' })).toHaveAttribute(
      'href',
      '/g/dev-fixture',
    );
    expect(await seriousViolations(page)).toEqual([]);
    await shoot(page, 'expired');
  });

  test('respects reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'processing', 2);
    const transition = await page
      .locator('.lm-progress > span')
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(transition).toBe('0s');
    await shoot(page, 'processing-reduced-motion');
  });
});
