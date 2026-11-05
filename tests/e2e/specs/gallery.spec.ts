import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Recipient gallery UI against the dev-only 2,000-item fixture (T17/T18, G-04, PRD §12).
 * Data wiring for `/g/[slug]` lands in T16; these specs cover the presentational behaviour.
 */
const FIXTURE = '/dev/gallery?n=2000';
const TOTAL = '2,000';
/** Generous upper bound: the windowed grid renders ~50–80 tiles on these viewports. */
const MAX_TILES = 250;

const tiles = (page: Page) => page.locator('[data-gallery-tile]');

async function openFixture(page: Page) {
  await page.goto(FIXTURE);
  await expect(tiles(page).first()).toBeAttached();
}

/** True once a tile is painted under one of several probe points in the viewport. */
function tileInViewport(page: Page) {
  return page.evaluate(() => {
    const xs = [0.25, 0.5, 0.75].map((f) => Math.round(window.innerWidth * f));
    const ys = [0.3, 0.5, 0.7].map((f) => Math.round(window.innerHeight * f));
    return xs.some((x) =>
      ys.some((y) => document.elementFromPoint(x, y)?.closest('[data-gallery-tile]')),
    );
  });
}

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test.describe('public gallery grid + lightbox (fixture)', () => {
  test('keeps the DOM tile count bounded while scrolling 2,000 items', async ({ page }) => {
    await openFixture(page);
    for (const fraction of [0.1, 0.35, 0.6, 0.85, 1]) {
      await page.evaluate((f) => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo({ top: Math.round(max * f), behavior: 'instant' });
      }, fraction);
      await expect.poll(() => tileInViewport(page)).toBe(true);
      const count = await tiles(page).count();
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(MAX_TILES);
    }
    await expect(page.locator('[data-index="1999"]')).toBeAttached();
    await expect(page.locator('[data-index="0"]')).not.toBeAttached();
  });

  test('opens with Enter, navigates with arrows, traps focus and restores it on Escape', async ({
    page,
  }) => {
    await openFixture(page);
    await page.locator('[data-index="3"]').focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByText(`4 of ${TOTAL}`)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByText(`6 of ${TOTAL}`)).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(dialog.getByText(`5 of ${TOTAL}`)).toBeVisible();

    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }

    for (const name of ['Close', 'Previous photo', 'Next photo']) {
      const box = await dialog.getByRole('button', { name }).boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-index="4"]')).toBeFocused();
  });

  test('closing far from the opener scrolls the current row into view', async ({ page }) => {
    await openFixture(page);
    await page.locator('[data-index="0"]').click();
    const dialog = page.getByRole('dialog');
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight');
    await expect(dialog.getByText(`41 of ${TOTAL}`)).toBeVisible();
    await page.keyboard.press('Escape');
    const tile = page.locator('[data-index="40"]');
    await expect(tile).toBeFocused();
    await expect(tile).toBeInViewport();
  });

  test('swipe navigates on touch devices', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'touch-only');
    await openFixture(page);
    await page.locator('[data-index="2"]').tap();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(`3 of ${TOTAL}`)).toBeVisible();

    const stage = await page.getByTestId('lightbox-stage').boundingBox();
    if (!stage) throw new Error('stage not laid out');
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (from: number, to: number) => {
      const y = stage.y + stage.height / 2;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: from, y }],
      });
      for (let step = 1; step <= 6; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: from + ((to - from) * step) / 6, y }],
        });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const left = stage.x + stage.width * 0.25;
    const right = stage.x + stage.width * 0.75;

    await swipe(right, left);
    await expect(dialog.getByText(`4 of ${TOTAL}`)).toBeVisible();
    await swipe(left, right);
    await expect(dialog.getByText(`3 of ${TOTAL}`)).toBeVisible();
  });

  test('has no serious or critical axe violations (grid and lightbox)', async ({ page }) => {
    await openFixture(page);
    expect(await seriousViolations(page)).toEqual([]);

    await page.locator('[data-index="5"]').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('has no horizontal scroll at 320 px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openFixture(page);
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.locator('[data-index="5"]').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});
