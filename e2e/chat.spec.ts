import type { Page } from '@playwright/test';
import {
  chatMessage,
  expect,
  model,
  MODEL_ID,
  project,
  seed,
  session,
  test,
} from './support/fixtures';
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

  test('streams text in without its fade under reduced motion', async ({ app, page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const composer = await openSession(page, app.start, {
      replies: [
        {
          steps: [{ kind: 'text', text: 'Reading the project files one by one.' }, { kind: 'hang' }],
        },
      ],
    });

    await composer.click();
    await page.keyboard.type('Run the long job');
    await page.keyboard.press('Enter');

    const main = page.getByRole('main');
    await expect(main).toContainText('Reading the project files one by one.');
    // The turn is still running, so the text that arrived last is still in its chunks.
    const chunk = main.locator('.stream-chunk').last();
    await expect(chunk).toHaveCSS('animation-name', 'none');

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(chunk).toHaveCSS('animation-name', 'stream-in');

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });

  test('shows a collapse chevron on the thinking box', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [
        {
          steps: [
            { kind: 'reasoning', text: 'Looking at the config first.' },
            { kind: 'text', text: 'Done.' },
          ],
        },
      ],
    });

    await composer.click();
    await page.keyboard.type('How do I run the checks?');
    await page.keyboard.press('Enter');

    const main = page.getByRole('main');
    const summary = main.locator('summary', { hasText: 'Thinking process' });
    const chevron = summary.locator('svg');
    await expect(chevron).toBeVisible();
    await expect(main.getByText('Looking at the config first.')).toBeHidden();
    await expect(chevron).not.toHaveClass(/(^|\s)rotate-90/);
    const closed = await chevron.evaluate((el) => getComputedStyle(el).rotate);

    await summary.click();
    await expect(main.getByText('Looking at the config first.')).toBeVisible();
    await expect
      .poll(() => chevron.evaluate((el) => getComputedStyle(el).rotate))
      .not.toBe(closed);
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

  test('the composer follows the height of its text without sizing it from script', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start);
    await composer.click();
    const height = () => composer.evaluate((editor) => editor.getBoundingClientRect().height);
    const empty = await height();

    // An inline height written per keystroke forces a full layout of the app,
    // which WebKitGTK's renderer without GPU compositing repaints on the CPU.
    await composer.evaluate((editor) => {
      const writes: string[] = [];
      new MutationObserver((records) => {
        for (const record of records) {
          writes.push((record.target as HTMLElement).getAttribute('style') ?? '');
        }
      }).observe(editor, { attributes: true, attributeFilter: ['style'] });
      (window as unknown as { composerStyleWrites: string[] }).composerStyleWrites = writes;
    });

    for (let line = 1; line <= 8; line += 1) {
      await page.keyboard.type(`line ${line}`);
      await page.keyboard.press('Shift+Enter');
    }
    await expect.poll(height).toBeGreaterThan(empty);

    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await expect.poll(height).toBe(empty);

    const writes = await page.evaluate(
      () => (window as unknown as { composerStyleWrites: string[] }).composerStyleWrites,
    );
    expect(writes).toEqual([]);
  });

  test('turns an image the webview pastes into the editor into an attachment', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start);
    await composer.click();
    await page.keyboard.type('Look at this');

    // WebKitGTK on X11: the paste event carries no files, items or text, and
    // the webview's own paste then inserts the image as a full-size <img>.
    await composer.evaluate(async (editor) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1920;
      canvas.height = 1080;
      canvas.getContext('2d')!.fillRect(0, 0, 1920, 1080);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
      const paste = new ClipboardEvent('paste', {
        clipboardData: new DataTransfer(),
        bubbles: true,
        cancelable: true,
      });
      if (editor.dispatchEvent(paste)) {
        document.execCommand('insertHTML', false, `<img src="${URL.createObjectURL(blob)}">`);
      }
    });

    const chip = page.locator('app-composer').getByText('image.png');
    await expect(chip).toBeVisible();
    await expect(composer.locator('img')).toHaveCount(0);

    await page.keyboard.press('Enter');
    const call = await app.backend.waitForCall('send_message');
    expect(call.args['content']).toBe('Look at this');
    const attachments = call.args['attachments'] as { mimeType: string; kind: string }[];
    expect(attachments).toEqual([
      expect.objectContaining({ kind: 'image', mimeType: 'image/png' }),
    ]);
  });

  test('puts the caret in the composer when the toggle shortcut brings the window back', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start);
    await composer.click();
    await composer.evaluate((editor) => editor.blur());
    await expect(composer).not.toBeFocused();

    await app.backend.emit('window-summoned');

    await expect(composer).toBeFocused();
    await page.keyboard.type('typed straight away');
    await expect(composer).toHaveText('typed straight away');
  });

  test('leaves focus in an open dialog when the window comes back', async ({ app, page }) => {
    await openSession(page, app.start, { apiKeys: [] });
    await page.getByRole('button', { name: 'Open settings' }).click();
    const keyInput = page.getByRole('dialog').locator('[data-provider-key="openrouter"]');
    await expect(keyInput).toBeFocused();

    await app.backend.emit('window-summoned');
    await page.keyboard.type('sk-or');

    await expect(keyInput).toBeFocused();
    await expect(keyInput).toHaveValue('sk-or');
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

  test('shows what a running command prints as it arrives', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [
        {
          steps: [
            {
              kind: 'tool',
              name: 'bash',
              summary: 'pnpm test',
              arguments: { command: 'pnpm test' },
              output: ['RUN v3.2.4\n', '✓ src/app/core/format.spec.ts (4 tests)\n'],
              hold: true,
              result: 'Command finished successfully.\nTest Files 1 passed',
            },
            { kind: 'text', text: 'All tests pass.' },
          ],
        },
      ],
    });

    await composer.click();
    await page.keyboard.type('Run the tests');
    await page.keyboard.press('Enter');

    // The output opens by itself while the command is still running.
    const main = page.getByRole('main');
    await expect(main.getByText('✓ src/app/core/format.spec.ts (4 tests)')).toBeVisible();
    await expect(main.getByText('RUN v3.2.4')).toBeVisible();

    // Once the command is over the card closes again and holds its result.
    await app.backend.resume();
    await expect(main).toContainText('All tests pass.');
    await expect(main.getByText('RUN v3.2.4')).toBeHidden();
    await main.getByRole('button', { name: /pnpm test/ }).click();
    await expect(main.getByText('Test Files 1 passed')).toBeVisible();
  });

  test('shows a screenshot the agent took in the chat', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [
        {
          steps: [
            {
              kind: 'tool',
              name: 'screenshot',
              summary: 'Settings page',
              arguments: { url: 'http://localhost:4200/settings', caption: 'Settings page' },
              result: 'Shown to the user in the chat: Settings page (1280×800).',
              attachments: [
                {
                  id: 'shot-1',
                  name: 'Settings page',
                  mimeType: 'image/png',
                  size: 68,
                  kind: 'image',
                  lines: null,
                  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
                },
              ],
            },
            { kind: 'text', text: 'Here is the new settings page.' },
          ],
        },
      ],
    });

    await composer.click();
    await page.keyboard.type('Restyle the settings page');
    await page.keyboard.press('Enter');

    const main = page.getByRole('main');
    await expect(main).toContainText('Here is the new settings page.');
    // The picture stays in the chat once the turn's messages are reloaded.
    const picture = main.getByRole('img', { name: 'Settings page' });
    await expect(picture).toBeVisible();
    await expect(picture).toHaveAttribute('src', /^data:image\/png;base64,/);

    await picture.click();
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  });

  test('shows where a turn compacted the conversation', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [
        {
          steps: [
            { kind: 'compact', summary: 'The parser bug is in **tokenize()**.' },
            { kind: 'text', text: 'Picking up from the summary.' },
          ],
        },
      ],
    });

    await composer.click();
    await page.keyboard.type('Keep going');
    await page.keyboard.press('Enter');

    const main = page.getByRole('main');
    await expect(main).toContainText('Picking up from the summary.');
    const divider = main.getByText('Context compacted');
    await expect(divider).toBeVisible();
    // The summary the model continues from is one click away.
    await expect(main.locator('strong', { hasText: 'tokenize()' })).toBeHidden();
    await divider.click();
    await expect(main.locator('strong', { hasText: 'tokenize()' })).toBeVisible();

    // It is part of the transcript, so it is still there after a restart.
    await page.reload();
    await expect(main.getByText('Context compacted')).toBeVisible();
  });

  test('shows how much of each request came from the cache', async ({ app, page }) => {
    await openSession(page, app.start, {
      messages: [
        chatMessage('user', 'First question'),
        chatMessage('assistant', 'Cold answer', { seq: 2, promptTokens: 1000 }),
        chatMessage('user', 'Second question', { seq: 3 }),
        chatMessage('assistant', 'Warm answer', {
          seq: 4,
          promptTokens: 2000,
          cachedTokens: 1500,
        }),
      ],
    });

    // The first request had nothing to reuse; the model reports hits, so it reads as a miss.
    const rates = page.getByRole('main').getByTestId('cache-rate');
    await expect(rates).toHaveText(['Cache 0.0%', 'Cache 75.0%']);
    await expect(rates.last()).toHaveAttribute('title', '1,500 / 2,000');
  });

  test('compacts a conversation on request', async ({ app, page }) => {
    const composer = await openSession(page, app.start);
    const compact = page.getByRole('button', { name: 'Compact context' });
    // There is nothing to compact in an empty chat.
    await expect(compact).toBeDisabled();

    await composer.click();
    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    const main = page.getByRole('main');
    await expect(main).toContainText('Echo: Hello');

    await compact.click();
    await expect(main.getByText('Context compacted')).toBeVisible();
    expect((await app.backend.lastCall('compact_session'))?.args).toMatchObject({
      sessionId: 'session-1',
    });
    await main.getByText('Context compacted').click();
    await expect(main).toContainText('Summary of the conversation so far.');
  });

  test('offers to continue a chat that was cut off when the app closed', async ({ app, page }) => {
    await openSession(page, app.start, {
      sessions: [session({ title: 'Refactor the parser', interrupted: true })],
      messages: [
        chatMessage('user', 'Refactor the parser'),
        chatMessage('assistant', 'Starting with the tokenizer.', { seq: 2 }),
      ],
      replies: [{ steps: [{ kind: 'text', text: 'The parser is refactored.' }] }],
    });

    const notice = page.getByTestId('chat-interrupted');
    await expect(notice).toContainText('interrupted before the agent finished');

    await notice.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('main')).toContainText('The parser is refactored.');
    await expect(notice).toHaveCount(0);
    // It goes on from where it was cut off, without a new prompt.
    expect((await app.backend.lastCall('send_message'))?.args).toMatchObject({
      sessionId: 'session-1',
      content: '',
      resume: true,
    });
    await expect(page.getByRole('main').getByText('Refactor the parser')).toHaveCount(1);
  });

  test('offers to continue a turn that the sleeping machine cut off', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [
        { steps: [{ kind: 'text', text: 'Reading the config.' }, { kind: 'interrupt' }] },
        { steps: [{ kind: 'text', text: 'All gates pass.' }] },
      ],
    });
    const notice = page.getByTestId('chat-interrupted');
    await expect(notice).toHaveCount(0);

    await composer.click();
    await page.keyboard.type('Run every gate');
    await page.keyboard.press('Enter');

    await expect(notice).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Reading the config.');
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

    await notice.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('main')).toContainText('All gates pass.');
    await expect(notice).toHaveCount(0);
  });

  test('a new prompt settles a chat that was cut off', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      sessions: [session({ title: 'Refactor the parser', interrupted: true })],
      messages: [chatMessage('user', 'Refactor the parser')],
    });
    const notice = page.getByTestId('chat-interrupted');
    await expect(notice).toBeVisible();

    await composer.click();
    await page.keyboard.type('Never mind, list the files');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('main')).toContainText('Echo: Never mind, list the files');
    await expect(notice).toHaveCount(0);
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

  test('exports an anonymized debug log after an error', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [
        { steps: [{ kind: 'error', message: 'OpenRouter returned 400: invalid tool_result' }] },
      ],
    });

    await composer.click();
    await page.keyboard.type(
      'Email jane.doe@example.com about /Users/e2e/code/demo-app with sk-test-4242',
    );
    await page.keyboard.press('Enter');

    const alert = page.getByRole('alert').filter({ hasText: 'invalid tool_result' });
    await alert.getByRole('button', { name: 'Export debug log' }).click();

    const dialog = page.getByTestId('debug-export');
    await expect(dialog).toContainText('The log can contain sensitive information');
    const preview = dialog.getByTestId('debug-export-preview');
    await expect(preview).toContainText('- OS: macOS 15.6 (24G84)');
    await expect(preview).toContainText('- App: pumr 0.0.0-e2e');
    await expect(preview).toContainText('OpenRouter returned 400: invalid tool_result');
    await expect(preview).toContainText('jane.doe@example.com');

    // Full-text search highlights matches and steps through them; Escape clears it.
    const search = dialog.getByRole('searchbox', { name: 'Search the log' });
    const matches = dialog.getByTestId('debug-export-matches');
    await search.fill('JANE.doe');
    await expect(matches).toHaveText(/\b1 of [2-9]\b/);
    await expect(preview.locator('mark').first()).toHaveText('jane.doe');
    await search.press('Enter');
    await expect(matches).toHaveText(/\b2 of [2-9]\b/);
    await search.press('Shift+Enter');
    await expect(matches).toHaveText(/\b1 of [2-9]\b/);
    await search.fill('no such text');
    await expect(matches).toHaveText('No matches');
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(dialog).toBeVisible();

    // The chat's own model is preselected for the anonymization.
    await expect(dialog.getByRole('button', { name: 'Model for anonymizing' })).toContainText(
      'Claude Sonnet 5',
    );
    await dialog.getByRole('button', { name: 'Anonymize', exact: true }).click();

    const redactions = dialog.getByTestId('redactions');
    await expect(redactions).toContainText('3 values will be replaced');
    await expect(preview).toContainText('Email [EMAIL_1] about ~/code/demo-app with [SECRET_1]');
    await expect(preview).not.toContainText('jane.doe@example.com');
    expect((await app.backend.lastCall('find_sensitive_data'))?.args['model']).toBe(MODEL_ID);

    // Unticked values stay in the log.
    const secret = redactions.getByRole('listitem').filter({ hasText: 'sk-test-4242' });
    await secret.getByRole('checkbox').uncheck();
    await expect(preview).toContainText('Email [EMAIL_1] about ~/code/demo-app with sk-test-4242');
    await secret.getByRole('checkbox').check();

    // The changes view shows each changed line before and after.
    await dialog.getByRole('tab', { name: /^Changes \(\d+\)$/ }).click();
    const changes = dialog.getByTestId('debug-export-changes');
    const promptLine = changes
      .getByTestId('debug-export-change')
      .filter({ hasText: 'sk-test-4242' });
    await expect(promptLine.locator('del')).toHaveText([
      'jane.doe@example.com',
      '/Users/e2e',
      'sk-test-4242',
    ]);
    await expect(promptLine.locator('ins')).toHaveText(['[EMAIL_1]', '~', '[SECRET_1]']);
    await search.fill('sk-test');
    await expect(matches).toHaveText('1 lines');
    await expect(changes.getByTestId('debug-export-change')).toHaveCount(1);
    await search.fill('');
    await dialog.getByRole('tab', { name: 'Preview (anonymized)' }).click();
    await expect(preview).toContainText('Email [EMAIL_1] about ~/code/demo-app with [SECRET_1]');

    await dialog.getByRole('button', { name: 'Save anonymized log…' }).click();
    await expect(dialog).toContainText('Saved to /Users/e2e/Downloads/pumr-debug-log-');
    const [saved] = (await app.backend.handle()).savedLogs;
    expect(saved.fileName).toMatch(/^pumr-debug-log-\d{4}-\d{2}-\d{2}-\d{4}-anonymized\.md$/);
    expect(saved.content).toContain('> Anonymized before export: 3 personal or secret values');
    expect(saved.content).toContain('OpenRouter returned 400: invalid tool_result');
    expect(saved.content).not.toContain('jane.doe@example.com');
    expect(saved.content).not.toContain('sk-test-4242');

    // Escape closes the export first, then the debugger.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Session debugger' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Session debugger' })).toHaveCount(0);
  });
});
