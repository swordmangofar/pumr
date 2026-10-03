import type { Page } from '@playwright/test';
import { expect, project, seed, session, test } from './support/fixtures';
import type { FakeSeed } from './support/fake-backend';

// The browser reports the host platform, which decides the default hotkeys.
const MAC = process.platform === 'darwin';
const NEW_TERMINAL_TAB = MAC ? 'Meta+t' : 'Control+Shift+T';
const CLOSE_TERMINAL_TAB = MAC ? 'Meta+w' : 'Control+Shift+W';
const CLOSE_SESSION_TAB = MAC ? 'Meta+w' : 'Control+w';

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

    // Closing the last terminal hides the dock.
    await page.keyboard.press(CLOSE_TERMINAL_TAB);
    await expect(dock).toBeHidden();

    // The session tab was never touched, and the keys never reached a shell.
    await expect(sessionTab).toBeVisible();
    expect(await app.backend.calls('create_session')).toEqual([]);
    expect(await app.backend.calls('terminal_write')).toEqual([]);
    expect(await app.backend.calls('terminal_open')).toHaveLength(2);
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
