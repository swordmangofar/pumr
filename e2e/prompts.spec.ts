import type { Page } from '@playwright/test';
import type { FakeReply } from './support/fake-backend';
import { expect, project, seed, session, test, type PumrApp } from './support/fixtures';

async function sendWithReply(page: Page, app: PumrApp, reply: FakeReply, prompt: string) {
  await page.addInitScript(() => {
    localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
    localStorage.setItem('pumr.activeTab', 'session-1');
  });
  await app.start(seed({ projects: [project()], sessions: [session()], replies: [reply] }));
  await page.getByRole('textbox', { name: /Describe your task/ }).click();
  await page.keyboard.type(prompt);
  await page.keyboard.press('Enter');
}

test.describe('agent prompts', () => {
  test('runs a command after the user allows it once', async ({ app, page }) => {
    await sendWithReply(
      page,
      app,
      {
        steps: [
          {
            kind: 'permission',
            command: 'npm install left-pad',
            justification: 'The build needs this package.',
          },
          { kind: 'text', text: 'Installed the dependency.' },
        ],
      },
      'Install left-pad',
    );

    const prompt = page.getByRole('dialog');
    await expect(prompt.getByText('npm install left-pad').first()).toBeVisible();
    await expect(prompt.getByText('The build needs this package.')).toBeVisible();
    await prompt.getByRole('button', { name: /^\d Yes$/ }).click();

    await expect(page.getByRole('main')).toContainText('Installed the dependency.');
    await expect(prompt).toHaveCount(0);
    const call = await app.backend.lastCall('resolve_permission');
    expect(call?.args).toMatchObject({ decision: 'allow_once', promptKind: 'command' });
  });

  test('reports a denied command back to the agent', async ({ app, page }) => {
    await sendWithReply(
      page,
      app,
      {
        steps: [
          { kind: 'permission', command: 'rm -rf build' },
          { kind: 'text', text: 'Okay, I left the build folder alone.' },
        ],
      },
      'Clean up',
    );

    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^\d No$/ })
      .click();

    await expect(page.getByRole('main')).toContainText('Okay, I left the build folder alone.');
    expect((await app.backend.lastCall('resolve_permission'))?.args['decision']).toBe('deny');
  });

  test('number keys approve only when the composer does not have focus', async ({ app, page }) => {
    await sendWithReply(
      page,
      app,
      {
        steps: [
          { kind: 'permission', command: 'cargo test' },
          { kind: 'text', text: 'All tests passed.' },
        ],
      },
      'Run the tests',
    );
    const prompt = page.getByRole('dialog');
    await expect(prompt.getByText('cargo test').first()).toBeVisible();

    // Still typing in the composer: the key is text, not an approval.
    await page.keyboard.press('1');
    await expect(page.getByRole('textbox', { name: /Describe your task/ })).toHaveText('1');
    expect(await app.backend.calls('resolve_permission')).toEqual([]);

    await prompt.getByText('Run command?').click();
    await page.keyboard.press('1');

    await expect(page.getByRole('main')).toContainText('All tests passed.');
    expect((await app.backend.lastCall('resolve_permission'))?.args['decision']).toBe('allow_once');
  });

  test('answers a question from the agent', async ({ app, page }) => {
    await sendWithReply(
      page,
      app,
      {
        steps: [
          {
            kind: 'question',
            question: {
              header: 'Package manager',
              question: 'Which package manager should I use?',
              multiSelect: false,
              options: [
                { label: 'npm', description: null, recommended: false },
                { label: 'pnpm', description: 'Matches the lockfile', recommended: true },
              ],
            },
          },
          { kind: 'text', text: 'Using pnpm.' },
        ],
      },
      'Set up the project',
    );

    await expect(page.getByText('Which package manager should I use?')).toBeVisible();
    await expect(page.getByText('Recommended')).toBeVisible();
    await page.getByRole('button', { name: /pnpm/ }).click();
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByRole('main')).toContainText('Using pnpm.');
    const call = await app.backend.lastCall('resolve_question');
    expect(call?.args['answers']).toEqual([
      expect.objectContaining({
        header: 'Package manager',
        question: 'Which package manager should I use?',
        selected: ['pnpm'],
      }),
    ]);
  });

  test('stopping a turn dismisses its open permission prompt', async ({ app, page }) => {
    await sendWithReply(
      page,
      app,
      { steps: [{ kind: 'permission', command: 'cargo publish' }] },
      'Publish the crate',
    );
    const prompt = page.getByRole('dialog');
    await expect(prompt.getByText('cargo publish').first()).toBeVisible();

    await page.getByRole('button', { name: 'Stop' }).click();

    await expect(prompt).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    expect(await app.backend.calls('resolve_permission')).toEqual([]);
  });
});
