import { expect, seed, test } from './support/fixtures';

test.describe('sandbox', () => {
  test('picks how far commands are confined and edits its lists', async ({ app, page }) => {
    const initial = seed();
    initial.settings.sandboxWritableFolders = ['~/.cargo'];
    initial.settings.sandboxUnreadableFolders = ['~/.ssh', '~/.aws'];
    await app.start(initial);

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Sandbox' }).click();
    await expect(dialog.getByTestId('sandbox-unavailable')).toHaveCount(0);
    await expect(dialog.getByTestId('sandbox-mode-files')).toBeChecked();

    await dialog.getByRole('radio', { name: 'Files and network' }).click();
    await expect(dialog.getByTestId('sandbox-mode-filesAndNetwork')).toBeChecked();
    await expect(dialog.getByTestId('sandbox-mode-files')).not.toBeChecked();

    const writable = dialog.getByTestId('sandbox-writable');
    await writable.getByRole('textbox').fill('~/.cache');
    await writable.getByRole('button', { name: 'Add folder' }).click();
    await expect(writable.getByText('~/.cache')).toBeVisible();
    // The field is ready for the next entry.
    await expect(writable.getByRole('textbox')).toHaveValue('');

    const unreadable = dialog.getByTestId('sandbox-unreadable');
    await unreadable.getByRole('button', { name: 'Remove' }).first().click();
    await expect(unreadable.getByText('~/.ssh')).toHaveCount(0);

    const excluded = dialog.getByTestId('sandbox-excluded');
    await expect(excluded.getByText('No commands added yet.')).toBeVisible();
    await excluded.getByRole('textbox').fill('pnpm e2e');
    await excluded.getByRole('textbox').press('Enter');
    await expect(excluded.getByText('pnpm e2e')).toBeVisible();

    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const saved = await app.backend.waitForCall('save_settings');
    expect(saved.args['settings']).toMatchObject({
      sandbox: 'filesAndNetwork',
      sandboxWritableFolders: ['~/.cargo', '~/.cache'],
      sandboxUnreadableFolders: ['~/.aws'],
      sandboxExcludedCommands: ['pnpm e2e'],
    });
  });

  test('says so where the system has no sandbox', async ({ app, page }) => {
    await app.start(seed({ sandboxSupport: { files: false, network: false } }));

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Sandbox' }).click();

    await expect(dialog.getByTestId('sandbox-unavailable')).toContainText(
      'This system has no sandbox pumr can use',
    );
    await expect(dialog.getByTestId('sandbox-mode-files')).toBeDisabled();
    await expect(dialog.getByTestId('sandbox-mode-filesAndNetwork')).toBeDisabled();
    await expect(dialog.getByTestId('sandbox-mode-off')).toBeEnabled();
  });

  test('offers no closed network where only files can be confined', async ({ app, page }) => {
    await app.start(seed({ sandboxSupport: { files: true, network: false } }));

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Sandbox' }).click();

    await expect(dialog.getByTestId('sandbox-mode-files')).toBeEnabled();
    await expect(dialog.getByTestId('sandbox-mode-filesAndNetwork')).toBeDisabled();
    await expect(dialog.getByText('Closing the network is only possible on macOS.')).toBeVisible();
    await expect(dialog.getByTestId('sandbox-unavailable')).toHaveCount(0);
  });
});
