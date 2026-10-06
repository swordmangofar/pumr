import type { Page } from '@playwright/test';
import type { FakeReply } from './support/fake-backend';
import { expect, model, project, seed, session, test, type PumrApp } from './support/fixtures';

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

/** Starts with three open chats, the first of which waits for a permission. */
async function startWithWaitingChat(page: Page, app: PumrApp, replies: FakeReply[] = []) {
  await page.addInitScript(() => {
    localStorage.setItem('pumr.tabs', JSON.stringify(['session-1', 'session-2', 'session-3']));
    localStorage.setItem('pumr.activeTab', 'session-1');
  });
  await app.start(
    seed({
      projects: [project()],
      sessions: [
        session({ title: 'Fix login bug', messageCount: 1 }),
        session({ id: 'session-2', title: 'Refactor parser', messageCount: 1 }),
        session({ id: 'session-3', title: 'Update docs', messageCount: 1 }),
      ],
      replies: [{ steps: [{ kind: 'permission', command: 'npm run migrate' }] }, ...replies],
    }),
  );
  await page.getByRole('textbox', { name: /Describe your task/ }).click();
  await page.keyboard.type('Run the migration');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByText('npm run migrate').first()).toBeVisible();
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

  test('answers a question from the keyboard and returns to the composer', async ({
    app,
    page,
  }) => {
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

    // The question takes the keyboard from the composer the prompt was sent from.
    await expect(page.getByRole('button', { name: 'npm', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /pnpm/ })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('button', { name: 'Submit' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('main')).toContainText('Using pnpm.');
    expect((await app.backend.lastCall('resolve_question'))?.args['answers']).toEqual([
      expect.objectContaining({ selected: ['pnpm'] }),
    ]);
    await expect(page.getByRole('textbox', { name: /Describe your task/ })).toBeFocused();
  });

  test('a question takes the keyboard from the session list', async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await app.start(
      seed({
        projects: [project()],
        sessions: [session()],
        replies: [
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
                    { label: 'pnpm', description: null, recommended: false },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    // The session list holds the arrow keys and Enter once it was clicked.
    await page.locator('app-sidebar').getByText('Existing session').click();
    await page.getByRole('textbox', { name: /Describe your task/ }).focus();
    await page.keyboard.type('Set up the project');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('button', { name: 'npm', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'pnpm', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('shows which answer has the keyboard after sending with the mouse', async ({
    app,
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await app.start(
      seed({
        projects: [project()],
        sessions: [session()],
        replies: [
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
                    { label: 'pnpm', description: null, recommended: false },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    await page.getByRole('textbox', { name: /Describe your task/ }).click();
    await page.keyboard.type('Set up the project');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // A button focused from script after a click gets no focus ring of its
    // own, so the panel draws one.
    const first = page.getByRole('button', { name: 'npm', exact: true });
    await expect(first).toBeFocused();
    await expect(first).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('button', { name: 'pnpm', exact: true })).toHaveCSS(
      'outline-style',
      'solid',
    );
    await expect(first).toHaveCSS('outline-style', 'none');
  });

  test('picks the model of a subagent from the suggested ones', async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await app.start(
      seed({
        projects: [project()],
        sessions: [session()],
        models: [
          model(),
          model('google/gemini-2.5-flash', 'Gemini 2.5 Flash'),
          model('google/gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite'),
          model('openai/gpt-5', 'GPT-5'),
        ],
        replies: [
          {
            steps: [
              {
                kind: 'modelChoice',
                query: 'gemini flash',
                candidates: ['google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite'],
              },
              { kind: 'text', text: 'The subagent is done.' },
            ],
          },
        ],
      }),
    );
    await page.getByRole('textbox', { name: /Describe your task/ }).click();
    await page.keyboard.type('Research this with a subagent on gemini flash');
    await page.keyboard.press('Enter');

    const prompt = page.getByTestId('model-choice');
    await expect(prompt).toContainText('"gemini flash" fits several models');
    // The closest match is preselected; the dropdown offers only the suggestions.
    const select = prompt.getByRole('button', { name: 'Which model should the subagent use?' });
    await expect(select).toContainText('Gemini 2.5 Flash');
    await select.click();
    const menu = prompt.locator('app-model-menu');
    await expect(menu.getByText('Gemini 2.5 Flash Lite')).toBeVisible();
    await expect(menu.getByText('GPT-5')).toHaveCount(0);
    await menu.getByText('Gemini 2.5 Flash Lite').click();
    await prompt.getByRole('button', { name: 'Use this model' }).click();

    await expect(page.getByRole('main')).toContainText('The subagent is done.');
    await expect(prompt).toHaveCount(0);
    expect((await app.backend.lastCall('resolve_model_choice'))?.args['model']).toBe(
      'google/gemini-2.5-flash-lite',
    );
  });

  test('names the model of a subagent that runs on another one', async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await app.start(
      seed({
        projects: [project()],
        sessions: [
          session({ messageCount: 1 }),
          session({
            id: 'sub-1',
            title: 'Research parsers',
            parentSessionId: 'session-1',
            model: 'google/gemini-2.5-flash',
            agentStatus: 'done',
          }),
          session({
            id: 'sub-2',
            title: 'Update docs',
            parentSessionId: 'session-1',
            agentStatus: 'done',
          }),
        ],
        models: [model(), model('google/gemini-2.5-flash', 'Gemini 2.5 Flash')],
      }),
    );

    await expect(page.getByRole('button', { name: /Update docs/ })).toBeVisible();
    // Only the subagent on another model than the chat's says which.
    await expect(page.getByTestId('agent-model')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Research parsers/ })).toContainText(
      'Gemini 2.5 Flash',
    );
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

  test('shows a banner for every other chat that waits on the user', async ({ app, page }) => {
    await startWithWaitingChat(page, app, [
      {
        steps: [
          {
            kind: 'question',
            question: {
              header: 'Parser',
              question: 'Which parser should I keep?',
              multiSelect: false,
              options: [{ label: 'The new one', description: null, recommended: false }],
            },
          },
        ],
      },
    ]);
    const prompt = page.getByRole('dialog');
    const banners = page.getByRole('main').getByRole('status');
    const tabs = page.getByRole('banner');
    // The chat on screen shows its own prompt, so there is nothing to point to.
    await expect(prompt.getByText('npm run migrate').first()).toBeVisible();
    await expect(banners).toHaveCount(0);

    await tabs.getByText('Refactor parser').click();
    await expect(banners).toHaveCount(1);
    await page.getByRole('textbox', { name: /Describe your task/ }).click();
    await page.keyboard.type('Clean up the parser');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Which parser should I keep?')).toBeVisible();

    await tabs.getByText('Update docs').click();
    await expect(banners).toHaveCount(2);
    const permission = banners.filter({ hasText: 'Fix login bug' });
    const question = banners.filter({ hasText: 'Refactor parser' });
    await expect(permission).toContainText('Permission needed');
    await expect(question).toContainText('Question waiting');

    await question.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banners).toHaveCount(1);
    await permission.getByRole('button', { name: 'Switch' }).click();

    await expect(prompt.getByText('npm run migrate').first()).toBeVisible();
    await expect(banners).toHaveCount(0);
  });

  test('the banner for waiting chats can be turned off in the settings', async ({ app, page }) => {
    await startWithWaitingChat(page, app);
    const banners = page.getByRole('main').getByRole('status');
    await page.getByRole('banner').getByText('Refactor parser').click();
    await expect(banners).toHaveCount(1);

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Notifications' }).click();
    await expect(dialog.getByText('Waiting chats banner')).toBeVisible();
    await dialog.getByRole('switch').click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(banners).toHaveCount(0);
    const saved = await app.backend.lastCall('save_settings');
    expect(saved?.args['settings']).toMatchObject({ waitingChatsBanner: false });
  });
});
