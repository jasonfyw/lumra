import { expect, test } from '@playwright/test';

/**
 * `/new` shell (T14) without the Supabase stack: the upload zone is there immediately, works from
 * the keyboard alone, and rejects unsupported files client-side before any upload request.
 */
test('upload zone is visible immediately and keyboard operable', async ({ page }) => {
  const uploadRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/upload-intents') || r.method() === 'PUT') uploadRequests.push(r.url());
  });
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: 'New gallery' })).toBeVisible();
  const choose = page.getByRole('button', { name: 'Choose photos' });
  await expect(choose).toBeVisible();
  const box = await choose.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

  // Tab from the top of the page to the picker button, then open it with the keyboard.
  await page.keyboard.press('Tab');
  for (let i = 0; i < 10 && !(await choose.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(choose).toBeFocused();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  const fileChooser = await chooser;
  expect(fileChooser.isMultiple()).toBe(true);
  await fileChooser.setFiles([
    { name: 'holiday.mov', mimeType: 'video/quicktime', buffer: Buffer.from('not a photo') },
    { name: 'DSC_0001.NEF', mimeType: 'image/x-nikon-nef', buffer: Buffer.from('raw bytes') },
  ]);

  const alert = page.getByRole('alert').filter({ hasText: 'weren’t added' });
  await expect(alert).toContainText('holiday.mov isn’t a supported photo');
  await expect(alert).toContainText('Use JPEG, PNG, WebP or HEIC');
  expect(uploadRequests).toEqual([]);
});
