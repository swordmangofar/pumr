import type { Page } from '@playwright/test';
import { expect, model, MODEL_ID, project, seed, session, test } from './support/fixtures';
import type { FakeSeed } from './support/fake-backend';

async function openSession(
  page: Page,
  start: (seed: FakeSeed) => Promise<void>,
  patch: Partial<FakeSeed> = {},
) {
  await page.addInitScript(() => {
    localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
    localStorage.setItem('pumr.activeTab', 'session-1');
  });
  await start(
    seed({ projects: [project()], sessions: [session({ title: 'New session' })], ...patch }),
  );
  return page.getByRole('textbox', { name: /Describe your task/ });
}

test.describe('chat', () => {
  test('sends a prompt and streams the markdown reply', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [
        {
          steps: [
            { kind: 'reasoning', text: 'Looking at the config first.' },
            { kind: 'text', text: 'Use **pnpm verify** to run every gate.' },
          ],
        },
      ],
    });

    await composer.click();
    await page.keyboard.type('How do I run the checks?');
    await page.keyboard.press('Enter');

    const main = page.getByRole('main');
    await expect(main.getByText('How do I run the checks?')).toBeVisible();
    await expect(main.locator('strong', { hasText: 'pnpm verify' })).toBeVisible();
    await expect(main).toContainText('Use pnpm verify to run every gate.');
    await expect(composer).toHaveText('');

    const call = await app.backend.lastCall('send_message');
    expect(call?.args).toMatchObject({
      sessionId: 'session-1',
      content: 'How do I run the checks?',
      model: MODEL_ID,
    });
    expect(String(call?.args['channel'])).toMatch(/^__CHANNEL__:\d+$/);

    // The backend renamed the session after the first prompt; the tab follows.
    await expect(page.getByRole('banner').getByText('How do I run the checks?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

    // The turn was persisted, so a restart shows the same conversation.
    await page.reload();
    await expect(main.getByText('How do I run the checks?')).toBeVisible();
    await expect(main.locator('strong', { hasText: 'pnpm verify' })).toBeVisible();
  });

  test('shows and filters models by provider', async ({ app, page }) => {
    const direct = 'anthropic:claude-opus-5';
    const composer = await openSession(page, app.start, {
      apiKeys: ['openrouter', 'anthropic'],
      models: [model(), model(direct, 'Claude Opus 5')],
      sessions: [session({ title: 'New session', model: direct })],
      replies: [{ steps: [{ kind: 'text', text: 'Hello from Claude.' }] }],
    });

    // The model button names the provider; direct models have no OpenRouter routing.
    const composerBar = page.locator('app-composer');
    const modelButton = composerBar.getByRole('button', { name: 'Claude Opus 5 Anthropic' });
    await expect(modelButton).toBeVisible();
    await expect(composerBar.getByText('Auto (best available)')).toHaveCount(0);

    await modelButton.click();
    const menu = page.locator('#composer-model-menu');
    await expect(menu.locator('[data-model-group]')).toContainText(['OpenRouter', 'Anthropic']);
    await menu.getByRole('button', { name: 'Anthropic 1' }).click();
    await expect(menu.locator('[data-model-group]')).toHaveCount(1);
    await expect(menu.locator('[data-model-group]')).toContainText('Anthropic');
    await expect(menu.getByText('Claude Sonnet 5')).toHaveCount(0);
    await menu.getByRole('button', { name: 'All', exact: true }).click();
    await expect(menu.getByText('Claude Sonnet 5')).toBeVisible();
    await page.keyboard.press('Escape');

    await composer.click();
    await page.keyboard.type('Hi Claude');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('main')).toContainText('Hello from Claude.');
    const call = await app.backend.lastCall('send_message');
    expect(call?.args).toMatchObject({ content: 'Hi Claude', model: direct });
    expect(call?.args['provider'] ?? null).toBeNull();
    expect(await app.backend.calls('list_endpoints')).toEqual([]);
  });

  test('a provider key alone is enough to chat', async ({ app, page }) => {
    await openSession(page, app.start, {
      apiKeys: ['openai'],
      models: [model(), model('openai:gpt-5', 'GPT-5')],
      sessions: [session({ title: 'New session', model: 'openai:gpt-5' })],
    });
    await expect(page.getByText('Connect a model provider in Settings')).toHaveCount(0);
    await expect(
      page.locator('app-composer').getByRole('button', { name: 'GPT-5 OpenAI' }),
    ).toBeVisible();
  });

  test('Shift+Enter inserts a new line instead of sending', async ({ app, page }) => {
    const composer = await openSession(page, app.start);

    await composer.click();
    await page.keyboard.type('first line');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second line');

    await expect(composer).toContainText('first line');
    await expect(composer).toContainText('second line');
    expect(await app.backend.calls('send_message')).toEqual([]);

    await page.getByRole('button', { name: 'Send' }).click();
    const call = await app.backend.waitForCall('send_message');
    expect(call.args['content']).toBe('first line\nsecond line');
  });

  test('does not send an empty prompt', async ({ app, page }) => {
    const composer = await openSession(page, app.start);

    await composer.click();
    await page.keyboard.press('Enter');
    await page.keyboard.type('   ');
    await page.keyboard.press('Enter');

    expect(await app.backend.calls('send_message')).toEqual([]);
  });

  test('stops a running turn', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [{ steps: [{ kind: 'text', text: 'Starting a long job' }, { kind: 'hang' }] }],
    });

    await composer.click();
    await page.keyboard.type('Run the long job');
    await page.keyboard.press('Enter');

    const stop = page.getByRole('button', { name: 'Stop' });
    await expect(stop).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Starting a long job');
    // Reverting would take back what the running turn is still writing.
    const revert = page.getByRole('button', { name: 'Revert to this prompt' });
    await expect(revert).toHaveCount(0);

    await stop.click();

    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    expect((await app.backend.lastCall('stop_generation'))?.args).toEqual({
      sessionId: 'session-1',
    });
    await expect(revert).toHaveCount(1);
  });

  test('queues a follow-up while a turn is running and sends it afterwards', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start, {
      replies: [
        { steps: [{ kind: 'text', text: 'Working on the first task' }, { kind: 'hang' }] },
        { steps: [{ kind: 'text', text: 'Second task done' }] },
      ],
    });

    await composer.click();
    await page.keyboard.type('First task');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();

    await composer.click();
    await page.keyboard.type('Second task');
    await page.getByRole('button', { name: 'Queue' }).click();
    await expect(page.getByText('Queued (1)')).toBeVisible();
    expect(await app.backend.calls('send_message')).toHaveLength(1);

    await page.getByRole('button', { name: 'Stop' }).click();

    await app.backend.waitForCall('send_message', 2);
    await expect(page.getByRole('main')).toContainText('Second task done');
    expect((await app.backend.calls('send_message'))[1].args['content']).toBe('Second task');
  });

  test('shows tool calls made during a turn', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [
        {
          steps: [
            {
              kind: 'tool',
              name: 'read_file',
              summary: 'src/main.ts',
              arguments: { path: 'src/main.ts' },
              result: 'bootstrapApplication(App, appConfig)',
            },
            { kind: 'text', text: 'The app bootstraps in main.ts.' },
          ],
        },
      ],
    });

    await composer.click();
    await page.keyboard.type('Where does the app start?');
    await page.keyboard.press('Enter');

    const main = page.getByRole('main');
    await expect(main).toContainText('The app bootstraps in main.ts.');
    await expect(main.getByText('read_file')).toBeVisible();
    await expect(main).toContainText('bootstrapApplication(App, appConfig)');
  });

  test('surfaces a backend error', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [{ steps: [{ kind: 'error', message: 'OpenRouter returned 429: rate limited' }] }],
    });

    await composer.click();
    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('main')).toContainText('OpenRouter returned 429: rate limited');
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });
});
