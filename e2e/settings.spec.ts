import { expect, model, seed, test } from './support/fixtures';

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

  test('switches the logo and persists it', async ({ app, page }) => {
    await app.start();
    const logo = page.getByTestId('app-logo');
    await expect(logo).toHaveAttribute('src', 'logo-mascot.svg');

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Appearance' }).click();
    await dialog.getByRole('button', { name: 'Classic face' }).click();

    // The header previews the choice before it is saved, like the theme does.
    await expect(logo).toHaveAttribute('src', 'logo-classic.svg');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    const saved = await app.backend.lastCall('save_settings');
    expect(saved?.args['settings']).toMatchObject({ logo: 'classic' });
    expect((await app.backend.state()).settings.logo).toBe('classic');
  });

  test('offers the vector logos and shows the picked one', async ({ app, page }) => {
    await app.start();
    const logo = page.getByTestId('app-logo');

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Appearance' }).click();
    await expect(dialog.getByRole('button', { name: 'Puma, tail up' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Shaded puma' }).click();

    await expect(logo).toHaveAttribute('src', 'logo-shaded.svg');
    // The file has to be served and has to decode, not just be referenced.
    await expect
      .poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBeGreaterThan(0);
  });

  test('starts with the saved logo and drops an unsaved choice', async ({ app, page }) => {
    const initial = seed();
    initial.settings.logo = 'classic';
    await app.start(initial);
    const logo = page.getByTestId('app-logo');
    await expect(logo).toHaveAttribute('src', 'logo-classic.svg');

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Appearance' }).click();
    await dialog.getByRole('button', { name: 'Sitting puma' }).click();
    await expect(logo).toHaveAttribute('src', 'logo-mascot.svg');
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();

    await expect(logo).toHaveAttribute('src', 'logo-classic.svg');
    expect(await app.backend.calls('save_settings')).toEqual([]);
  });

  test('connects a provider with its key and lists its models', async ({ app, page }) => {
    await app.start(seed({ models: [model(), model('anthropic:claude-opus-5', 'Claude Opus 5')] }));

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('1 connected')).toBeVisible();
    const card = dialog.locator('[data-provider="anthropic"]');
    await expect(card).toContainText('Not connected');
    await card.getByRole('button', { name: /Anthropic/ }).click();

    const keyInput = card.locator('input[type="password"]');
    await expect(keyInput).toHaveAttribute('placeholder', 'sk-ant-...');
    await keyInput.fill('sk-ant-e2e-placeholder');
    await keyInput.press('Enter');

    const call = await app.backend.lastCall('set_api_key');
    expect(call?.args).toEqual({ provider: 'anthropic', key: 'sk-ant-e2e-placeholder' });
    await expect(dialog.getByText('2 connected')).toBeVisible();
    await expect(card).toContainText('Connected');
    await expect(card).toContainText('1 models');
    await expect(keyInput).toHaveValue('');

    await card.getByRole('button', { name: 'Delete key' }).click();
    expect((await app.backend.lastCall('delete_api_key'))?.args).toEqual({
      provider: 'anthropic',
    });
    await expect(card).toContainText('Not connected');
    expect((await app.backend.state()).apiKeys).toEqual(['openrouter']);
  });

  test('turns on a local model server without a key', async ({ app, page }) => {
    await app.start(seed({ models: [model(), model('ollama:llama3.1:8b', 'llama3.1:8b')] }));

    await page.getByRole('button', { name: 'Settings' }).click();
    const card = page.getByRole('dialog').locator('[data-provider="ollama"]');
    await card.getByRole('button', { name: /Ollama/ }).click();
    await expect(card.getByPlaceholder(/sk-/)).toHaveCount(0);
    await card.getByRole('switch').click();

    const call = await app.backend.lastCall('update_provider');
    expect(call?.args).toMatchObject({ provider: 'ollama', enabled: true });
    await expect(card).toContainText('1 models');

    await card.getByPlaceholder('http://localhost:11434/v1').fill('http://127.0.0.1:11500/v1');
    await card.getByPlaceholder('http://localhost:11434/v1').press('Enter');
    await expect
      .poll(async () => (await app.backend.state()).settings.providers['ollama']?.baseUrl)
      .toBe('http://127.0.0.1:11500/v1');
    // Saved right away: closing the dialog without Save keeps it.
    expect(await app.backend.calls('save_settings')).toEqual([]);
  });

  test('finds providers beyond the popular ones', async ({ app, page }) => {
    await app.start();

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('[data-provider="togetherai"]')).toBeVisible();
    await expect(dialog.locator('[data-provider="wandb"]')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Show all 1 more providers' }).click();
    await expect(dialog.locator('[data-provider="wandb"]')).toBeVisible();
    await dialog.getByRole('button', { name: 'Show only popular providers' }).click();

    const search = dialog.getByRole('searchbox', { name: 'Search providers...' });
    await search.fill('corewea');
    await expect(dialog.locator('[data-provider]')).toHaveCount(1);
    await expect(dialog.locator('[data-provider="wandb"]')).toContainText('CoreWeave');
    await search.fill('nothing-like-this');
    await expect(dialog.getByText('No provider matches your search.')).toBeVisible();
  });

  test('picks a handover model from the model menu', async ({ app, page }) => {
    await app.start(seed({ models: [model(), model('openai/gpt-5', 'GPT-5')] }));

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    const field = dialog.getByRole('button', { name: 'Handover model' });
    await expect(field).toContainText('Use the current session model');

    await field.click();
    const menu = dialog.locator('app-model-menu');
    await expect(menu.locator('[data-model-group]')).toContainText(['OpenRouter']);
    await menu.getByPlaceholder('Search models...').fill('gpt');
    await expect(menu.getByText('Claude Sonnet 5')).toHaveCount(0);
    await menu.getByRole('button', { name: /GPT-5/ }).first().click();
    await expect(menu).toHaveCount(0);
    await expect(field).toContainText('GPT-5');

    // Escape closes only the menu, not the settings dialog.
    await field.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const saved = await app.backend.lastCall('save_settings');
    expect(saved?.args['settings']).toMatchObject({ handoverModel: 'openai/gpt-5' });

    await field.click();
    await menu.getByRole('button', { name: 'Use the current session model' }).click();
    await expect(field).toContainText('Use the current session model');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(async () => (await app.backend.lastCall('save_settings'))?.args['settings'])
      .toMatchObject({ handoverModel: null });
  });

  test('shows the command that summons the window where a shortcut cannot', async ({
    app,
    page,
  }) => {
    // A Wayland desktop: pumr cannot register a system-wide shortcut there.
    const command = '/home/ada/Apps/pumr.AppImage --toggle';
    await app.start(
      seed({
        windowControl: { toggleCommand: command, globalShortcut: false, shortcutError: null },
      }),
    );

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Window', exact: true }).click();

    await expect(dialog.getByTestId('window-shortcut-unavailable')).toContainText('Wayland');
    await expect(dialog.getByTestId('window-toggle-command')).toHaveText(command);

    // What the command does when pumr is in front is set without the shortcut.
    await dialog.getByRole('button', { name: 'Minimize', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const saved = await app.backend.lastCall('save_settings');
    expect(saved?.args['settings']).toMatchObject({
      windowToggleEnabled: false,
      windowToggleAction: 'minimize',
    });
  });

  test('leaves the shortcut alone where it works', async ({ app, page }) => {
    await app.start();

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Window', exact: true }).click();

    await expect(dialog.getByTestId('window-toggle-command')).toHaveText('/usr/bin/pumr --toggle');
    await expect(dialog.getByTestId('window-shortcut-unavailable')).toHaveCount(0);
    await expect(dialog.getByTestId('window-shortcut-error')).toHaveCount(0);
  });

  test('says why a shortcut that is switched on does nothing', async ({ app, page }) => {
    // Another application holds the combination, so registering it fails.
    await app.start(
      seed({
        settings: { ...seed().settings, windowToggleEnabled: true },
        windowControl: {
          toggleCommand: '/usr/bin/pumr --toggle',
          globalShortcut: true,
          shortcutError: 'HotKey already registered',
        },
      }),
    );

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Window', exact: true }).click();

    const hint = dialog.getByTestId('window-shortcut-error');
    await expect(hint).toContainText('could not be registered');
    await expect(hint).toContainText('HotKey already registered');
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
