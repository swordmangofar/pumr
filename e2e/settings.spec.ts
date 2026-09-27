import { expect, seed, test } from './support/fixtures';

test.describe('settings', () => {
  test('switches the interface language and persists it', async ({ app, page }) => {
    await app.start();

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'General' }).click();

    await dialog.locator('select:has(option[value="de"])').selectOption('de');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    // Translations load over HTTP, so this also checks de.json is served.
    await expect(page.getByRole('button', { name: 'Einstellungen' })).toBeVisible();
    const saved = await app.backend.lastCall('save_settings');
    expect(saved?.args['settings']).toMatchObject({ language: 'de' });
    expect((await app.backend.state()).settings.language).toBe('de');
  });

  test('starts in the saved language', async ({ app, page }) => {
    const initial = seed();
    initial.settings.language = 'fr';
    await app.start(initial);

    await expect(page.getByRole('button', { name: 'Paramètres' })).toBeVisible();
  });

  test('closing without saving keeps the stored settings', async ({ app, page }) => {
    await app.start();

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'General' }).click();
    await dialog.locator('select:has(option[value="es"])').selectOption('es');
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
    expect(await app.backend.calls('save_settings')).toEqual([]);
  });
});
