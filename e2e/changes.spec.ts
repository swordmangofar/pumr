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
