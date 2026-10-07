import type { Page } from '@playwright/test';
import type { FakeReply, FakeStep } from './support/fake-backend';
import { expect, project, seed, session, test, type PumrApp } from './support/fixtures';

// A project that needs another toolchain than the machine starts with: the
// agent puts a JDK on PATH in front of every build command.
const jdk = '/Users/e2e/.sdkman/candidates/java/11.0.32-amzn/bin';

/** A Gradle run with JDK 11 on PATH, as a new line for every test filter. */
function gradle(tests: string): FakeStep {
  const command = `PATH=${jdk}:$PATH ./gradlew test --tests '*${tests}'`;
  return {
    kind: 'permission',
    command,
    request: {
      detail: `Command adds ${jdk} to PATH, which the assistant can change: it is in the allowed folder /Users/e2e/.sdkman/candidates/java`,
      suggestedRule: './gradlew *',
      risk: {
        level: 'high',
        detail: 'A file in a folder on PATH runs in place of the program of the same name.',
      },
      scopeOptions: [
        { kind: 'pathFolder', rule: { kind: 'exact', value: jdk } },
        { kind: 'exact', rule: { kind: 'exact', value: command } },
      ],
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
  await page.keyboard.type('Run the cart and order tests');
  await page.keyboard.press('Enter');
}

test.describe('a folder on PATH', () => {
  test('trusting it for the chat stops every line that uses it from asking', async ({
    app,
    page,
  }) => {
    await sendWithReply(page, app, {
      steps: [gradle('CartTest'), gradle('OrderTest'), { kind: 'text', text: 'Both runs passed.' }],
    });

    const prompt = page.getByRole('dialog');
    await expect(prompt.getByText('CartTest').first()).toBeVisible();
    const remember = prompt.locator('[data-action="allow_session"]');
    // What is remembered is the folder, shortened like every folder.
    await expect(remember.getByTestId('path-chip')).toHaveText(
      'PATH: ~/.sdkman/candidates/java/11.0.32-amzn/bin',
    );
    // A high-risk prompt never preselects a remembering choice.
    await expect(prompt.locator('[data-action="allow"]')).toHaveClass(/border-accent\/60/);
    await remember.click();

    // The second line has another test filter and the same folder: no prompt.
    await expect(page.getByRole('main')).toContainText('Both runs passed.');
    const decisions = await app.backend.calls('resolve_permission');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].args).toMatchObject({
      decision: 'allow_session',
      commandRules: [{ kind: 'exact', value: jdk }],
    });
    expect((await app.backend.state()).settings.pathFolders).toEqual([]);
  });

  test('a folder trusted for good is listed in the settings and can be taken back', async ({
    app,
    page,
  }) => {
    await sendWithReply(page, app, {
      steps: [gradle('CartTest'), { kind: 'text', text: 'Done.' }],
    });
    await page.getByRole('dialog').locator('[data-action="allow_always"]').click();
    await expect(page.getByRole('main')).toContainText('Done.');
    expect((await app.backend.state()).settings.pathFolders).toEqual([jdk]);

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Agent white- and blacklist' }).click();
    const folders = dialog.getByTestId('path-folders');
    await expect(folders.getByTestId('path-folder')).toHaveText(new RegExp(jdk));

    await folders.getByTestId('path-folder').getByRole('button').click();
    await expect(folders).toContainText('No folders trusted on PATH yet.');
    expect((await app.backend.lastCall('delete_path_folder'))?.args['folder']).toBe(jdk);
    expect((await app.backend.state()).settings.pathFolders).toEqual([]);
  });

  test('the exact line can be remembered instead, and then the next line asks', async ({
    app,
    page,
  }) => {
    await sendWithReply(page, app, {
      steps: [gradle('CartTest'), gradle('OrderTest'), { kind: 'text', text: 'Both runs passed.' }],
    });
    const prompt = page.getByRole('dialog');
    await prompt.getByTestId('customize').click();
    const panel = prompt.getByTestId('customize-panel');
    await expect(panel).toContainText('Folder on PATH');
    await expect(panel).toContainText('A folder trusted on PATH may be put there by commands');
    await panel.getByRole('button', { name: /Exact/ }).click();
    const remember = prompt.locator('[data-action="allow_session"]');
    await expect(remember.getByTestId('path-chip')).toHaveCount(0);
    await remember.click();

    // Only that line was remembered; the folder is not trusted.
    await expect(prompt.getByText('OrderTest').first()).toBeVisible();
    await prompt.locator('[data-action="allow"]').click();
    await expect(page.getByRole('main')).toContainText('Both runs passed.');
    expect(await app.backend.calls('resolve_permission')).toHaveLength(2);
  });
});

test.describe('the environment of a project', () => {
  async function openProjectSettings(page: Page, app: PumrApp) {
    await app.start(seed({ projects: [project()], sessions: [session()] }));
    // The pencil only shows while the pointer is over the project's row.
    await page.getByRole('button', { name: 'Edit project' }).dispatchEvent('click');
    const dialog = page.locator('app-project-appearance-dialog');
    await expect(dialog.getByRole('heading', { name: 'Project settings' })).toBeVisible();
    await expect(dialog.getByTestId('project-environment')).toBeVisible();
    return dialog;
  }

  test('is typed once and saved with the project', async ({ app, page }) => {
    const dialog = await openProjectSettings(page, app);
    const field = dialog.getByTestId('project-environment');
    await expect(dialog).toContainText('One NAME=value per line');
    const text = 'JAVA_HOME=~/.sdkman/candidates/java/11.0.32-amzn\nPATH=$JAVA_HOME/bin:$PATH';
    await field.fill(text);
    await dialog.getByRole('button', { name: 'Confirm' }).click();

    const saved = await app.backend.waitForCall('set_project_environment');
    expect(saved.args).toMatchObject({ projectId: 'project-1', environment: text });
    expect((await app.backend.state()).projects[0].environment).toBe(text);
    await expect(dialog.getByTestId('project-environment')).toHaveCount(0);

    // It is there again when the dialog is opened the next time.
    await page.getByRole('button', { name: 'Edit project' }).dispatchEvent('click');
    await expect(page.getByTestId('project-environment')).toHaveValue(text);
  });

  test('says which line is no assignment and saves nothing', async ({ app, page }) => {
    const dialog = await openProjectSettings(page, app);
    await dialog.getByTestId('project-environment').fill('JAVA_HOME=/opt/jdk\nnvm use 14');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByTestId('project-environment-error')).toHaveText(
      'Line 2 is not NAME=value.',
    );
    expect(await app.backend.calls('set_project_environment')).toHaveLength(0);

    // What the backend refuses is shown with its reason.
    await dialog.getByTestId('project-environment').fill('PATH=node_modules/.bin:$PATH');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByTestId('project-environment-error')).toContainText(
      "Could not save the environment: PATH names 'node_modules/.bin'",
    );
    expect((await app.backend.state()).projects[0].environment ?? null).toBeNull();
  });
});

test.describe('folders for reading only', () => {
  test('are kept in a list of their own next to the folders for changes', async ({
    app,
    page,
  }) => {
    await app.start(seed({ projects: [project()], sessions: [session()] }));
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Workspace' }).click();
    await expect(dialog).toContainText('Folders for reading only');

    const readable = dialog.getByTestId('read-folders');
    await expect(readable).toContainText('No folders added yet.');
    await app.backend.setPickFolder('/opt/jdks');
    await readable.getByRole('button', { name: 'Add folder' }).click();
    await expect(readable).toContainText('/opt/jdks');
    await expect(dialog.getByTestId('allowed-folders')).not.toContainText('/opt/jdks');

    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const saved = await app.backend.waitForCall('save_settings');
    expect(saved.args['settings']).toMatchObject({ readFolders: ['/opt/jdks'], extraFolders: [] });
  });
});
