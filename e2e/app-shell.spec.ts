import { chatMessage, expect, project, seed, session, test } from './support/fixtures';

test.describe('app shell', () => {
  test('boots into the empty workspace inside Tauri', async ({ app, page }) => {
    await app.start();

    await expect(page.getByRole('banner').getByText('pumr', { exact: true })).toBeVisible();
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
});
