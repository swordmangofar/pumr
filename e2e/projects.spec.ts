import { chatMessage, expect, project, seed, session, test } from './support/fixtures';

test.describe('projects and sessions', () => {
  test('adds a project from the folder picker', async ({ app, page }) => {
    await app.start(seed({ pickFolder: '/Users/e2e/code/rocket' }));

    await page.getByTitle('Add project').click();

    const sidebar = page.getByRole('button', { name: /rocket/ }).first();
    await expect(sidebar).toBeVisible();
    await expect(page.getByText('No projects yet. Add a folder to get started.')).toHaveCount(0);
    const dialog = await app.backend.lastCall('plugin:dialog|open');
    expect(dialog?.args['options']).toMatchObject({ directory: true, multiple: false });
    expect((await app.backend.lastCall('add_project'))?.args).toEqual({
      path: '/Users/e2e/code/rocket',
    });
  });

  test('does nothing when the folder picker is cancelled', async ({ app, page }) => {
    await app.start(seed({ pickFolder: null }));

    await page.getByTitle('Add project').click();
    await app.backend.waitForCall('plugin:dialog|open');

    expect(await app.backend.calls('add_project')).toEqual([]);
    await expect(page.getByText('No projects yet. Add a folder to get started.')).toBeVisible();
  });

  test('sorts projects alphabetically, by session count or by last activity', async ({
    app,
    page,
  }) => {
    await app.start(
      seed({
        projects: [
          project({ id: 'p-zebra', name: 'zebra', lastOpenedAt: 1_700_000_003_000 }),
          project({ id: 'p-mango', name: 'mango', lastOpenedAt: 1_700_000_002_000 }),
          project({ id: 'p-apple', name: 'apple', lastOpenedAt: 1_700_000_001_000 }),
        ],
        sessions: [
          session({ id: 's-1', projectId: 'p-mango', title: 'Mango one' }),
          session({ id: 's-2', projectId: 'p-mango', title: 'Mango two' }),
          session({
            id: 's-3',
            projectId: 'p-apple',
            title: 'Apple one',
            updatedAt: 1_700_000_009_000,
          }),
        ],
      }),
    );
    // A project row reads "▾ A apple 1": toggle, icon letter, name, session count.
    const names = page.getByRole('button', { name: /^[▾▸] \w (zebra|mango|apple) \d+$/ });
    const order = async () =>
      (await names.allInnerTexts()).map((text) => /zebra|mango|apple/.exec(text)?.[0]);

    await expect.poll(order).toEqual(['apple', 'mango', 'zebra']);

    await page.getByRole('button', { name: 'Sort projects' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Alphabetical' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.getByRole('menuitemradio', { name: 'Session count' }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect.poll(order).toEqual(['mango', 'apple', 'zebra']);

    await page.getByRole('button', { name: 'Sort projects' }).click();
    await page.getByRole('menuitemradio', { name: 'Last activity' }).click();
    await expect.poll(order).toEqual(['apple', 'zebra', 'mango']);

    await page.reload();
    await expect.poll(order).toEqual(['apple', 'zebra', 'mango']);
  });

  test('creates a session with the default model and mode', async ({ app, page }) => {
    await app.start(seed({ projects: [project()] }));

    await page.getByTitle('New session').last().click();

    await expect(page.getByRole('banner').getByText('New session')).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Describe your task/ })).toBeVisible();
    expect((await app.backend.lastCall('create_session'))?.args).toMatchObject({
      projectId: 'project-1',
      model: 'anthropic/claude-sonnet-5',
      reasoningEffort: 'medium',
      modeId: 'coding',
    });
    const { sessions } = await app.backend.state();
    expect(sessions).toHaveLength(1);
  });

  test('closing an unused session tab deletes the empty session', async ({ app, page }) => {
    await app.start(seed({ projects: [project()] }));
    await page.getByTitle('New session').last().click();
    const tab = page.getByRole('banner').getByText('New session');
    await expect(tab).toBeVisible();

    await page.getByRole('button', { name: 'Close tab' }).click();

    await expect(tab).toHaveCount(0);
    await app.backend.waitForCall('delete_session');
    expect((await app.backend.state()).sessions).toEqual([]);
  });

  test('closing a tab with history keeps the session', async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await app.start(
      seed({
        projects: [project()],
        sessions: [session({ messageCount: 2 })],
        messages: [chatMessage('user', 'Hi'), chatMessage('assistant', 'Hello!', { seq: 2 })],
      }),
    );

    await page.getByRole('button', { name: 'Close tab' }).click();

    await expect(page.getByRole('banner').getByText('Existing session')).toHaveCount(0);
    // Still listed in the sidebar and reopenable from there.
    await page.getByRole('button', { name: 'Existing session' }).click();
    await expect(page.getByRole('banner').getByText('Existing session')).toBeVisible();
    expect(await app.backend.calls('delete_session')).toEqual([]);
  });
});
