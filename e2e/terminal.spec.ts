import type { Page } from '@playwright/test';
import { chatMessage, expect, project, seed, session, test } from './support/fixtures';
import type { PumrApp } from './support/fixtures';
import type { FakeSeed } from './support/fake-backend';

// The browser reports the host platform, which decides the default hotkeys.
const MAC = process.platform === 'darwin';
const NEW_TERMINAL_TAB = MAC ? 'Meta+t' : 'Control+t';
const CLOSE_TERMINAL_TAB = MAC ? 'Meta+w' : 'Control+w';
const CLOSE_SESSION_TAB = MAC ? 'Meta+w' : 'Control+w';
const TOGGLE_TERMINAL = MAC ? 'Meta+j' : 'Control+`';

/** Opens a session and the terminal dock below it, with the terminal focused. */
async function openTerminal(
  page: Page,
  start: (seed: FakeSeed) => Promise<void>,
  patch: Partial<FakeSeed> = {},
) {
  await page.addInitScript(() => {
    localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
    localStorage.setItem('pumr.activeTab', 'session-1');
  });
  await start(
    seed({ projects: [project()], sessions: [session({ title: 'Fix login bug' })], ...patch }),
  );
  await page.getByRole('button', { name: 'Toggle terminal' }).click();
  const dock = page.locator('app-terminal-dock');
  await expect(dock.getByText('Terminal 1')).toBeVisible();
  await expect(dock.locator('app-terminal-view textarea')).toBeFocused();
  return dock;
}

test.describe('terminal dock', () => {
  test('opens and closes terminal tabs with the tab hotkeys while focused', async ({
    app,
    page,
  }) => {
    const dock = await openTerminal(page, app.start);
    const sessionTab = page.getByRole('banner').getByText('Fix login bug');
    const closeButtons = dock.getByRole('button', { name: 'Close terminal' });

    await page.keyboard.press(NEW_TERMINAL_TAB);
    await expect(dock.getByText('Terminal 2')).toBeVisible();
    await expect(closeButtons).toHaveCount(2);
    // The new terminal takes the focus, so the hotkeys keep working.
    await expect(dock.locator('app-terminal-view textarea').nth(1)).toBeFocused();

    await page.keyboard.press(CLOSE_TERMINAL_TAB);
    await expect(dock.getByText('Terminal 2')).toHaveCount(0);
    await expect(closeButtons).toHaveCount(1);
    await expect(dock.locator('app-terminal-view textarea')).toBeFocused();

    // Closing the last terminal hides the dock and hands the keyboard to the chat.
    await page.keyboard.press(CLOSE_TERMINAL_TAB);
    await expect(dock).toBeHidden();
    await expect(page.getByRole('textbox', { name: /Describe your task/ })).toBeFocused();

    // The session tab was never touched, and the keys never reached a shell.
    await expect(sessionTab).toBeVisible();
    expect(await app.backend.calls('create_session')).toEqual([]);
    expect(await app.backend.calls('terminal_write')).toEqual([]);
    expect(await app.backend.calls('terminal_open')).toHaveLength(2);
  });

  test('focuses the chat when the dock is closed', async ({ app, page }) => {
    const dock = await openTerminal(page, app.start);
    const composer = page.getByRole('textbox', { name: /Describe your task/ });
    const toggle = page.getByRole('button', { name: 'Toggle terminal' });
    const terminal = dock.locator('app-terminal-view textarea');

    await page.keyboard.press(TOGGLE_TERMINAL);
    await expect(dock).toBeHidden();
    await expect(composer).toBeFocused();

    await toggle.click();
    await expect(terminal).toBeFocused();
    await toggle.click();
    await expect(dock).toBeHidden();
    await expect(composer).toBeFocused();

    await toggle.click();
    await expect(terminal).toBeFocused();
    await dock.getByRole('button', { name: 'Hide terminal' }).click();
    await expect(dock).toBeHidden();
    await expect(composer).toBeFocused();

    // The prompt can be typed straight away, and none of it reached a shell.
    await page.keyboard.type('hello');
    await expect(composer).toHaveText('hello');
    expect(await app.backend.calls('terminal_write')).toEqual([]);
  });

  test('leaves the tab hotkeys to the session tabs outside the terminal', async ({
    app,
    page,
  }) => {
    const dock = await openTerminal(page, app.start);

    await page.getByRole('textbox', { name: /Describe your task/ }).click();
    await page.keyboard.press(CLOSE_SESSION_TAB);

    await expect(page.getByRole('banner').getByText('Fix login bug')).toHaveCount(0);
    expect(await app.backend.calls('terminal_close')).toEqual([]);
    await expect(dock).toBeVisible();
  });

  test('uses the configured terminal tab hotkeys', async ({ app, page }) => {
    const settings = seed().settings;
    const dock = await openTerminal(page, app.start, {
      settings: {
        ...settings,
        hotkeys: { terminalNewTab: 'Ctrl+Shift+Y', terminalCloseTab: 'Ctrl+Shift+U' },
      },
    });
    const closeButtons = dock.getByRole('button', { name: 'Close terminal' });

    await page.keyboard.press('Control+Shift+Y');
    await expect(closeButtons).toHaveCount(2);

    // The default key is free again and goes to the shell.
    if (!MAC) {
      await page.keyboard.press(NEW_TERMINAL_TAB);
      await expect(closeButtons).toHaveCount(2);
    }

    await page.keyboard.press('Control+Shift+U');
    await expect(closeButtons).toHaveCount(1);
  });
});

test.describe('running a command from the chat', () => {
  const PUSH = 'git push -u origin version-1';
  const reply = [
    'I am not allowed to push. Push with:',
    '',
    '```bash',
    PUSH,
    '```',
    '',
    'The remote is configured like this:',
    '',
    '```toml',
    'remote = "origin"',
    '```',
  ].join('\n');

  async function openChat(page: Page, start: (seed: FakeSeed) => Promise<void>) {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await start(
      seed({
        projects: [project()],
        sessions: [session({ title: 'Release' })],
        messages: [chatMessage('user', 'Push the branch'), chatMessage('assistant', reply)],
      }),
    );
  }

  /** What reached the shells, in order, by terminal. */
  async function written(app: PumrApp) {
    const calls = await app.backend.calls('terminal_write');
    return calls.map(({ args }) => [args['terminalId'], args['data']]);
  }

  test('offers to run shell blocks only', async ({ app, page }) => {
    await openChat(page, app.start);

    const blocks = page.locator('app-markdown-code');
    await expect(blocks).toHaveCount(2);
    await expect(blocks.nth(0).getByRole('button', { name: 'Run in terminal' })).toBeVisible();
    await expect(blocks.nth(0).getByRole('button', { name: 'Copy' })).toBeVisible();
    await expect(blocks.nth(1).getByRole('button', { name: 'Run in terminal' })).toHaveCount(0);
    await expect(blocks.nth(1).getByRole('button', { name: 'Copy' })).toBeVisible();
  });

  test('opens the terminal and runs the command at its prompt', async ({ app, page }) => {
    await openChat(page, app.start);
    const dock = page.locator('app-terminal-dock');
    await expect(dock).toBeHidden();

    await page.getByRole('button', { name: 'Run in terminal' }).click();

    await expect(dock.getByText('Terminal 1')).toBeVisible();
    await expect.poll(() => written(app)).toEqual([
      ['terminal-1', PUSH],
      ['terminal-1', '\r'],
    ]);
    // A password the command asks for can be typed straight away.
    await expect(dock.locator('app-terminal-view textarea')).toBeFocused();

    // The terminal waits at its prompt again, so it takes the next command too.
    await page.getByRole('button', { name: 'Run in terminal' }).click();
    await expect.poll(async () => (await written(app)).length).toBe(4);
    expect(await app.backend.calls('terminal_open')).toHaveLength(1);
    expect(await app.backend.calls('terminal_busy')).toHaveLength(1);
  });

  test('uses a new terminal while a program runs in the one on show', async ({ app, page }) => {
    await openChat(page, app.start);
    const dock = page.locator('app-terminal-dock');
    await page.getByRole('button', { name: 'Toggle terminal' }).click();
    await expect(dock.getByText('Terminal 1')).toBeVisible();
    await app.backend.waitForCall('terminal_open');
    await app.backend.setBusyTerminals('terminal-1');

    await page.getByRole('button', { name: 'Run in terminal' }).click();

    await expect(dock.getByText('Terminal 2')).toBeVisible();
    await expect.poll(() => written(app)).toEqual([
      ['terminal-2', PUSH],
      ['terminal-2', '\r'],
    ]);
  });
});
