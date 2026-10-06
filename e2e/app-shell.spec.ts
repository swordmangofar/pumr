import { MODEL_ID, chatMessage, expect, project, seed, session, test } from './support/fixtures';

test.describe('app shell', () => {
  test('boots into the empty workspace inside Tauri', async ({ app, page }) => {
    await app.start();

    await expect(page.getByRole('banner').getByTestId('app-logo')).toBeVisible();
    // The "must run inside Tauri" warning only shows in a plain browser.
    await expect(page.getByText('pumr must run inside Tauri')).toHaveCount(0);
    await expect(page.getByText('No projects yet. Add a folder to get started.')).toBeVisible();
    await expect(page.getByRole('main')).toContainText(
      'Open a session from the sidebar or create a new one.',
    );

    const commands = (await app.backend.calls()).map((call) => call.cmd);
    expect(commands).toEqual(
      expect.arrayContaining([
        'get_settings',
        'list_llm_providers',
        'list_models',
        'list_projects',
        'list_running_turns',
      ]),
    );
  });

  test('gives the panels a height of their own rather than stretching them', async ({
    app,
    page,
  }) => {
    await app.start();

    // A stretched panel renders the same here, but WebKit lays it out twice
    // on every pass and repaints both times, which WebKitGTK's renderer
    // without GPU compositing does on the CPU for most of the window.
    const heights = await page
      .getByRole('main')
      .evaluate((main) =>
        Array.from(main.parentElement?.children ?? [], (panel) =>
          String(panel.computedStyleMap().get('height')),
        ),
      );
    expect(heights).toEqual(['100%', '100%', '100%']);
  });

  test('shows the pointer over whatever can be clicked', async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await app.start(seed({ projects: [project()], sessions: [session()] }));
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

    // Tailwind 4 leaves buttons with the arrow cursor, so the stylesheet gives
    // every control the pointer unless it is disabled.
    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button'))
        .filter((button) => button.offsetParent !== null)
        .map((button) => ({
          disabled: button.disabled,
          cursor: getComputedStyle(button).cursor,
        })),
    );
    const enabled = buttons.filter((button) => !button.disabled);
    expect(enabled.length).toBeGreaterThan(10);
    expect([...new Set(enabled.map((button) => button.cursor))]).toEqual(['pointer']);
    // Send has nothing to send yet.
    const disabled = buttons.filter((button) => button.disabled);
    expect(disabled.length).toBeGreaterThan(0);
    expect(disabled.filter((button) => button.cursor === 'pointer')).toEqual([]);
  });

  test('toggles keep awake from the header', async ({ app, page }) => {
    await app.start();

    const toggle = page.getByRole('button', { name: 'Keep awake while agents work' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveAttribute('title', /may go to sleep/);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAttribute('title', /stays awake/);
    // Saved at once rather than with the settings dialog: saving is what
    // makes the backend hold the machine awake.
    const saved = await app.backend.lastCall('save_settings');
    expect(saved?.args['settings']).toMatchObject({ keepAwake: true });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect((await app.backend.state()).settings.keepAwake).toBe(false);
  });

  test('restores open tabs and the active session after a restart', async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1', 'session-2']));
      localStorage.setItem('pumr.activeTab', 'session-2');
    });
    await app.start(
      seed({
        projects: [project()],
        sessions: [
          session({ id: 'session-1', title: 'Refactor parser', messageCount: 1 }),
          session({ id: 'session-2', title: 'Fix login bug', messageCount: 2 }),
        ],
        messages: [
          chatMessage('user', 'Parser prompt', { sessionId: 'session-1' }),
          chatMessage('user', 'Why does login fail?', { sessionId: 'session-2' }),
          chatMessage('assistant', 'The token expired.', { sessionId: 'session-2', seq: 2 }),
        ],
      }),
    );

    const tabs = page.getByRole('banner');
    await expect(tabs.getByText('Refactor parser')).toBeVisible();
    await expect(tabs.getByText('Fix login bug')).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByText('Why does login fail?')).toBeVisible();
    await expect(main.getByText('The token expired.')).toBeVisible();
    await expect(main.getByText('Parser prompt')).toHaveCount(0);

    await tabs.getByText('Refactor parser').click();
    await expect(main.getByText('Parser prompt')).toBeVisible();
    await expect(main.getByText('The token expired.')).toHaveCount(0);
  });

  test('ignores stored tabs whose sessions no longer exist', async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['deleted-session']));
      localStorage.setItem('pumr.activeTab', 'deleted-session');
    });
    await app.start(seed({ projects: [project()] }));

    await expect(page.getByRole('main')).toContainText(
      'Open a session from the sidebar or create a new one.',
    );
    expect(await app.backend.calls('list_messages')).toEqual([]);
  });

  test('asks for an API key and hides the hint once one is saved', async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await app.start(seed({ apiKeys: [], projects: [project()], sessions: [session()] }));

    const hint = page.getByText('Connect a model provider in Settings to start chatting.');
    await expect(hint).toBeVisible();
    await page.getByRole('button', { name: 'Open settings' }).click();

    const dialog = page.getByRole('dialog');
    const keyInput = dialog.locator('[data-provider-key="openrouter"]');
    await expect(keyInput).toHaveAttribute('placeholder', 'sk-or-v1-...');
    await expect(keyInput).toBeFocused();
    await keyInput.fill('sk-or-v1-e2e-placeholder');
    await keyInput.press('Enter');

    await expect(hint).toHaveCount(0);
    const call = await app.backend.lastCall('set_api_key');
    expect(call?.args).toEqual({ provider: 'openrouter', key: 'sk-or-v1-e2e-placeholder' });
    await expect(keyInput).toHaveValue('');
  });

  test('explains how to set a default model once the first provider is connected', async ({
    app,
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await app.start(
      seed({
        apiKeys: [],
        settings: { ...seed().settings, defaultModel: null },
        projects: [project()],
        sessions: [session({ model: null })],
      }),
    );

    // Without a provider there is nothing to choose from yet.
    const hint = page.getByTestId('no-default-model');
    await expect(hint).toHaveCount(0);
    await page.getByRole('button', { name: 'Open settings' }).click();
    const dialog = page.getByRole('dialog');
    const setup = dialog.getByTestId('default-model-setup');
    await expect(setup).toHaveCount(0);

    const keyInput = dialog.locator('[data-provider-key="openrouter"]');
    await keyInput.fill('sk-or-v1-e2e-placeholder');
    await keyInput.press('Enter');
    await expect(setup).toContainText('Choose a default model');
    await expect(setup).toContainText('pick one under “Default model” further down this page');

    // Closing the settings without choosing leaves the explanation in the chat.
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(hint).toContainText('No default model yet.');
    await hint.getByRole('button', { name: 'Open settings' }).click();
    const field = dialog.getByRole('button', { name: 'Default model', exact: true });
    await expect(field).toBeFocused();
    await expect(field).toBeInViewport();
    await expect(field).toContainText('Select a model');

    await field.click();
    await dialog
      .locator('app-model-menu')
      .getByRole('button', { name: /Claude Sonnet 5/ })
      .first()
      .click();
    await expect(field).toContainText('Claude Sonnet 5');
    // Nothing is saved yet, so the explanation stays until Save.
    await expect(setup).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(setup).toHaveCount(0);
    await expect(hint).toHaveCount(0);
    const saved = await app.backend.lastCall('save_settings');
    expect(saved?.args['settings']).toMatchObject({ defaultModel: MODEL_ID });
  });
});
