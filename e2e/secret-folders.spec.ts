import type { Page } from '@playwright/test';
import type { FakeReply, FakeStep } from './support/fake-backend';
import { expect, project, seed, session, test, type PumrApp } from './support/fixtures';

const credentials = '/home/me/secrets/credentials';

/** A Jira call that reads its token from a credential file, as a skill would. */
function jiraCall(issue: string): FakeStep {
  return {
    kind: 'permission',
    command: `curl -s -H "Authorization: Bearer $(cat "${credentials}/jira-credentials")" "https://jira.example.com/rest/api/2/issue/${issue}"`,
    request: {
      detail: `A command substitution needs approval: Command touches paths outside the project: ${credentials}/jira-credentials`,
      suggestedRule: null,
      risk: {
        level: 'danger',
        detail: 'It touches sensitive files outside the project and could expose credentials.',
      },
      folders: [credentials],
      secretFolders: [credentials],
    },
  };
}

async function sendWithReply(page: Page, app: PumrApp, reply: FakeReply) {
  await page.addInitScript(() => {
    localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
    localStorage.setItem('pumr.activeTab', 'session-1');
  });
  await app.start(seed({ projects: [project()], sessions: [session()], replies: [reply] }));
  await page.getByRole('textbox', { name: /Describe your task/ }).click();
  await page.keyboard.type('Look at SI-1 and LIC-7');
  await page.keyboard.press('Enter');
}

test.describe('sensitive files in a released folder', () => {
  test('releasing a folder for the chat stops its secrets from asking', async ({ app, page }) => {
    await sendWithReply(page, app, {
      steps: [jiraCall('SI-1'), jiraCall('LIC-7'), { kind: 'text', text: 'Read both tickets.' }],
    });

    const prompt = page.getByRole('dialog');
    await expect(prompt.getByText('issue/SI-1').first()).toBeVisible();
    const remember = prompt.locator('[data-action="allow_session"]');
    // The folder, and apart from it the sensitive files in it.
    await expect(remember.getByTestId('secret-chip')).toHaveText(
      `sensitive files in ${credentials}`,
    );
    // A prompt about secrets never preselects a remembering choice.
    await expect(prompt.locator('[data-action="allow"]')).toHaveClass(/border-accent\/60/);
    await remember.click();

    // The second call reads the same file for another ticket: no prompt.
    await expect(page.getByRole('main')).toContainText('Read both tickets.');
    const decisions = await app.backend.calls('resolve_permission');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].args).toMatchObject({
      decision: 'allow_session',
      folders: [credentials],
      secretFolders: [credentials],
    });
    expect((await app.backend.state()).settings.secretFolders).toEqual([]);
  });

  test('a folder released for good is listed in the settings and can be taken back', async ({
    app,
    page,
  }) => {
    await sendWithReply(page, app, {
      steps: [jiraCall('SI-1'), { kind: 'text', text: 'Done.' }],
    });
    await page.getByRole('dialog').locator('[data-action="allow_always"]').click();
    await expect(page.getByRole('main')).toContainText('Done.');
    expect((await app.backend.state()).settings.secretFolders).toEqual([credentials]);

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Agent white- and blacklist' }).click();
    const folders = dialog.getByTestId('secret-folders');
    await expect(folders.getByTestId('secret-folder')).toHaveText(new RegExp(credentials));

    await folders.getByTestId('secret-folder').getByRole('button').click();
    await expect(folders).toContainText('No folders with released sensitive files yet.');
    expect((await app.backend.lastCall('delete_secret_folder'))?.args['folder']).toBe(credentials);
    expect((await app.backend.state()).settings.secretFolders).toEqual([]);
  });

  test('the folder can be allowed while its secrets keep asking', async ({ app, page }) => {
    await sendWithReply(page, app, {
      steps: [jiraCall('SI-1'), jiraCall('LIC-7'), { kind: 'text', text: 'Read both tickets.' }],
    });
    const prompt = page.getByRole('dialog');
    await prompt.getByTestId('customize').click();
    await prompt.getByTestId('secret-folder-option').click();
    await expect(prompt.locator('[data-action="allow_session"]').getByTestId('secret-chip')).toHaveCount(0);
    await prompt.locator('[data-action="allow_session"]').click();

    // Nothing was released, so the next call asks again.
    await expect(prompt.getByText('issue/LIC-7').first()).toBeVisible();
    await prompt.locator('[data-action="allow"]').click();
    await expect(page.getByRole('main')).toContainText('Read both tickets.');
    expect(await app.backend.calls('resolve_permission')).toHaveLength(2);
  });
});
