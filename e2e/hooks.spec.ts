import { expect, project, seed, test } from './support/fixtures';
import type { Hook } from '../src/app/core/models';

function hook(patch: Partial<Hook> = {}): Hook {
  return {
    id: 'hook-1',
    enabled: true,
    event: 'afterTool',
    tools: 'edit|write',
    files: '*.ts',
    command: 'prettier --write "$PUMR_FILE"',
    timeoutSeconds: 60,
    project: '',
    ...patch,
  };
}

test.describe('hooks', () => {
  test('adds a hook that runs before a command and saves it', async ({ app, page }) => {
    await app.start();

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Hooks' }).click();
    await expect(dialog.getByTestId('no-hooks')).toHaveText('No hooks added yet.');

    await dialog.getByTestId('add-hook').click();
    const card = dialog.getByTestId('hook');
    await card.getByTestId('hook-event').selectOption({ label: 'Before a tool call' });
    await card.getByTestId('hook-tools').fill('bash');
    await card.getByTestId('hook-command').fill("grep -q 'push --force' && exit 2; exit 0");
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    const saved = await app.backend.waitForCall('save_settings');
    const hooks = (saved.args['settings'] as { hooks: Hook[] }).hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      enabled: true,
      event: 'beforeTool',
      tools: 'bash',
      files: '',
      command: "grep -q 'push --force' && exit 2; exit 0",
      timeoutSeconds: 60,
      project: '',
    });
    expect(hooks[0].id).not.toBe('');
  });

  test('a hook for the end of a turn names neither tools nor files', async ({ app, page }) => {
    const initial = seed({ projects: [project({ path: '/work/shop', name: 'shop' })] });
    initial.settings.hooks = [hook()];
    await app.start(initial);

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Hooks' }).click();
    const card = dialog.getByTestId('hook');
    await expect(card.getByTestId('hook-tools')).toHaveValue('edit|write');
    await expect(card.getByTestId('hook-files')).toHaveValue('*.ts');

    await card.getByTestId('hook-event').selectOption({ label: 'When the agent wants to finish' });
    await expect(card.getByTestId('hook-tools')).toHaveCount(0);
    await expect(card.getByTestId('hook-files')).toHaveCount(0);
    await card.getByTestId('hook-command').fill('pnpm check:i18n >&2 || exit 2');
    await card.getByTestId('hook-project').selectOption({ label: 'shop' });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    const saved = await app.backend.waitForCall('save_settings');
    expect((saved.args['settings'] as { hooks: Hook[] }).hooks).toEqual([
      hook({
        event: 'turnEnd',
        command: 'pnpm check:i18n >&2 || exit 2',
        project: '/work/shop',
      }),
    ]);
  });

  test('switches a hook off and removes it', async ({ app, page }) => {
    const initial = seed();
    initial.settings.hooks = [hook(), hook({ id: 'hook-2', command: 'eslint "$PUMR_FILE"' })];
    await app.start(initial);

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Hooks' }).click();
    const cards = dialog.getByTestId('hook');
    await expect(cards).toHaveCount(2);

    await cards.nth(0).getByRole('switch').click();
    await cards.nth(1).getByRole('button', { name: 'Remove hook' }).click();
    await expect(cards).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    const saved = await app.backend.waitForCall('save_settings');
    expect((saved.args['settings'] as { hooks: Hook[] }).hooks).toEqual([hook({ enabled: false })]);
  });
});
