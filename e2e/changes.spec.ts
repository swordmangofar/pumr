import type { Page } from '@playwright/test';
import type { FakeStep } from './support/fake-backend';
import { expect, project, seed, session, test, type PumrApp } from './support/fixtures';

const write = (writes: Record<string, string | null>): FakeStep => ({
  kind: 'tool',
  name: 'write',
  summary: Object.keys(writes).join(', '),
  result: 'ok',
  writes,
});

/** Starts a turn in a repository; the turn plays `steps` and then keeps running. */
async function startTurn(page: Page, app: PumrApp, steps: FakeStep[]): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
    localStorage.setItem('pumr.activeTab', 'session-1');
  });
  await app.start(
    seed({
      projects: [project()],
      sessions: [session()],
      files: { 'README.md': '# demo\n', 'notes.txt': 'alpha\n' },
      repo: true,
      replies: [{ steps: [...steps, { kind: 'hang' }] }],
    }),
  );
  await page.getByRole('textbox', { name: /Describe your task/ }).click();
  await page.keyboard.type('Update the notes');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
}

const leftTab = (page: Page, name: string) =>
  page.locator('app-sidebar').getByRole('button', { name, exact: true }).first();

test.describe('changes of a running turn', () => {
  test('list the changed files next to the chat', async ({ app, page }) => {
    await startTurn(page, app, [
      { kind: 'pause' },
      write({ 'notes.txt': 'bravo\n', 'docs/plan.md': 'plan\n' }),
    ]);
    const panel = page.locator('app-right-panel');
    await expect(panel).toContainText('No file changes yet');

    await app.backend.resume();

    await expect(panel.getByRole('button', { name: /notes\.txt/ })).toBeVisible();
    await expect(panel.getByRole('button', { name: /docs\/plan\.md/ })).toBeVisible();
  });

  test('update the diff that is open next to the chat', async ({ app, page }) => {
    await startTurn(page, app, [
      write({ 'notes.txt': 'bravo\n' }),
      { kind: 'pause' },
      write({ 'notes.txt': 'charlie\n' }),
    ]);
    const panel = page.locator('app-right-panel');
    await panel.getByRole('button', { name: /notes\.txt/ }).click();
    const diff = panel.locator('app-diff-view');
    await expect(diff).toContainText('bravo');

    await app.backend.resume();

    await expect(diff).toContainText('charlie');
  });

  test('show up in the workspace tree', async ({ app, page }) => {
    await startTurn(page, app, [
      { kind: 'pause' },
      write({ 'docs/plan.md': 'plan\n', 'README.md': null }),
    ]);
    await leftTab(page, 'Workspace').click();
    const tree = page.locator('app-workspace-tree');
    await expect(tree.getByRole('button', { name: 'README.md' })).toBeVisible();

    await app.backend.resume();

    await expect(tree.getByRole('button', { name: 'plan.md' })).toBeVisible();
    await expect(tree.getByRole('button', { name: 'README.md' })).toHaveCount(0);
  });

  test('reach the file that is open in the editor', async ({ app, page }) => {
    await startTurn(page, app, [{ kind: 'pause' }, write({ 'notes.txt': 'bravo\n' })]);
    await leftTab(page, 'Workspace').click();
    await page.locator('app-workspace-tree').getByRole('button', { name: 'notes.txt' }).click();
    const editor = page.locator('app-workspace-editor');
    await expect(editor).toContainText('alpha');

    await app.backend.resume();

    await expect(editor).toContainText('bravo');
  });

  test('show up in the git view', async ({ app, page }) => {
    await startTurn(page, app, [{ kind: 'pause' }, write({ 'notes.txt': 'bravo\n' })]);
    await leftTab(page, 'Git').click();
    const view = page.locator('app-git-view');
    await expect(view).toContainText('No local changes');

    await app.backend.resume();

    await expect(view).toContainText('notes.txt');
  });
});

test.describe('the project of the workspace and git tabs', () => {
  const projectIds = (calls: { args: Record<string, unknown> }[]) =>
    calls.map((call) => call.args['projectId']);

  async function startWithTwoProjects(page: Page, app: PumrApp): Promise<void> {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1', 'session-2']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await app.start(
      seed({
        projects: [
          project(),
          project({ id: 'project-2', name: 'other-app', path: '/Users/e2e/code/other-app' }),
        ],
        sessions: [
          session(),
          session({ id: 'session-2', projectId: 'project-2', title: 'Other session' }),
        ],
        files: { 'README.md': '# demo\n', 'notes.txt': 'alpha\n' },
        repo: true,
      }),
    );
  }

  test('is picked in the workspace tab and leaves the open session alone', async ({
    app,
    page,
  }) => {
    await startWithTwoProjects(page, app);
    await leftTab(page, 'Workspace').click();
    const picker = page.locator('app-workspace-tree app-project-select');
    // Until the user picks one, it is the project of the session the app started on.
    await expect(picker.getByRole('button', { name: /demo-app/ })).toBeVisible();
    expect(projectIds(await app.backend.calls('list_workspace_entries'))).not.toContain(
      'project-2',
    );

    await picker.getByRole('button', { name: /demo-app/ }).click();
    await picker.getByRole('menuitemradio', { name: /other-app/ }).click();

    await expect(picker.getByRole('button', { name: /other-app/ })).toBeVisible();
    await expect(picker.getByRole('menu')).toHaveCount(0);
    await expect
      .poll(async () => projectIds(await app.backend.calls('list_workspace_entries')))
      .toContain('project-2');
    // The chat on screen is still the one of the first project.
    await expect(page.getByRole('banner')).toContainText('demo-app');
    await expect(page.getByRole('banner')).not.toContainText('other-app');

    await page.locator('app-workspace-tree').getByRole('button', { name: 'notes.txt' }).click();

    await expect(page.locator('app-workspace-editor')).toContainText('alpha');
    expect((await app.backend.lastCall('read_workspace_file'))?.args).toEqual({
      projectId: 'project-2',
      path: 'notes.txt',
    });
  });

  test('does not follow the open session, is shared with the git tab and survives a reload', async ({
    app,
    page,
  }) => {
    await startWithTwoProjects(page, app);
    await leftTab(page, 'Git').click();
    const picker = page.locator('app-git-sidebar app-project-select');
    await expect(picker.getByRole('button', { name: /demo-app/ })).toBeVisible();

    await page.getByRole('banner').getByText('Other session').click();

    await expect(page.getByRole('banner')).toContainText('other-app');
    await expect(picker.getByRole('button', { name: /demo-app/ })).toBeVisible();
    expect(projectIds(await app.backend.calls('get_git_status'))).not.toContain('project-2');

    await picker.getByRole('button', { name: /demo-app/ }).click();
    await picker.getByRole('menuitemradio', { name: /other-app/ }).click();

    await expect
      .poll(async () => projectIds(await app.backend.calls('get_git_status')))
      .toContain('project-2');

    await leftTab(page, 'Workspace').click();
    const treePicker = page.locator('app-workspace-tree app-project-select');
    await expect(treePicker.getByRole('button', { name: /other-app/ })).toBeVisible();

    await page.reload();

    await expect(treePicker.getByRole('button', { name: /other-app/ })).toBeVisible();
  });
});
