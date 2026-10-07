import type { Page } from '@playwright/test';
import { expect, model, MODEL_ID, project, seed, session, test } from './support/fixtures';
import type { FakeSeed } from './support/fake-backend';
import type { EndpointInfo, Mode } from '../src/app/core/models';

function endpoint(
  providerName: string,
  slug: string,
  patch: Partial<EndpointInfo> = {},
): EndpointInfo {
  return {
    name: `${providerName} | ${MODEL_ID}`,
    slug,
    providerName,
    providerSlug: slug.split('/')[0],
    contextLength: 200_000,
    promptPricePerM: 3,
    completionPricePerM: 15,
    cacheReadPricePerM: 0.3,
    uptimeLast5m: null,
    uptimeLast30m: 99.9,
    uptimeLast1d: 99.5,
    throughputLast30m: 82,
    latencyLast30m: 640,
    maxCompletionTokens: null,
    quantization: null,
    supportsImplicitCaching: false,
    training: false,
    retainsPrompts: null,
    blocked: false,
    blockedReason: null,
    ...patch,
  };
}

function mode(id: string, name: string, description: string, planOnly = false): Mode {
  return {
    id,
    name,
    description,
    systemPrompt: '',
    userPromptIds: [],
    mcpServers: [],
    skills: [],
    includeGlobalPrompts: true,
    includeProjectRules: true,
    planOnly,
    builtin: true,
  };
}

/** The built-in modes that matter here, as `config::default_modes` has them. */
const MODES = [
  mode('coding', 'Coding', 'Full coding mode.'),
  mode('planning', 'Planning', 'Plans a feature with you.', true),
  mode('nacked', 'Nacked', 'Only the main system prompt.'),
];

// The browser reports the host platform, which decides the default hotkey.
const TOGGLE_MODE = process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P';

/** "Your prompts": a built-in one and one the user wrote. */
const PROMPTS = [
  { id: 'code-review', name: 'Code Review', prompt: 'Review the requested changes.' },
  { id: 'custom-1', name: 'Release notes', prompt: 'Write release notes for the change.' },
];

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
    seed({
      projects: [project()],
      sessions: [session({ title: 'New session' })],
      settings: { ...seed().settings, userSystemPrompts: PROMPTS },
      ...patch,
    }),
  );
  return page.getByRole('textbox', { name: /Describe your task/ });
}

test.describe('slash commands', () => {
  test('lists the commands after a slash and narrows them while typing', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start);
    const menu = page.getByRole('listbox');

    await expect(composer).toHaveAttribute('data-placeholder', /· \/ for commands$/);
    await composer.click();
    await page.keyboard.type('/');
    // The chat box's own commands and one for each of the user's prompts.
    await expect(menu.getByRole('option')).toHaveText([
      /^\/btw/,
      /^\/code-review\s*Applies your prompt “Code Review” to what you type after it/,
      /^\/effort/,
      /^\/mode\s*Switch the mode/,
      /^\/model/,
      /^\/provider/,
      /^\/release-notes/,
      /^\/revert/,
    ]);

    await page.keyboard.type('mo');
    await expect(menu.getByRole('option')).toHaveText([
      /^\/mode\s*Switch the mode/,
      /^\/model\s*Switch the model/,
    ]);

    // Escape closes the menu and leaves what was typed.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveText('/mo');
  });

  test('/effort picks a reasoning level with the arrow keys', async ({ app, page }) => {
    const composer = await openSession(page, app.start);
    const menu = page.getByRole('listbox');
    const levels = page.getByRole('group', { name: 'Reasoning' });

    await composer.click();
    await page.keyboard.type('/eff');
    await page.keyboard.press('Enter');
    await expect(menu.getByRole('option')).toHaveText(['Off', 'Low', 'Medium', 'High']);
    // It opens on the level that is in effect.
    await expect(menu.getByRole('option', { selected: true })).toHaveText('Medium');

    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('option', { selected: true })).toHaveText('High');
    await page.keyboard.press('Enter');

    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveText('');
    await expect(composer).toBeFocused();
    await expect(levels.getByRole('button', { name: 'High' })).toBeVisible();
    expect((await app.backend.lastCall('update_session'))?.args).toMatchObject({
      sessionId: 'session-1',
      reasoningEffort: 'high',
    });
    expect(await app.backend.calls('send_message')).toEqual([]);

    // Typing the level works as well.
    await page.keyboard.type('/effort lo');
    await page.keyboard.press('Enter');
    await expect(levels.getByRole('button', { name: 'Low' })).toBeVisible();
  });

  test('/mode lists the modes and switches to the picked one', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      settings: { ...seed().settings, modes: MODES },
    });
    const menu = page.getByRole('listbox');
    const picker = page.locator('app-composer').getByRole('button', { name: 'Coding' });

    await expect(picker).toBeVisible();
    await composer.click();
    await page.keyboard.type('/mode ');
    await expect(menu.getByRole('option')).toHaveText([
      /^Coding\s*Full coding mode\./,
      /^Planning\s*Plan only · Plans a feature with you\./,
      /^Nacked\s*Only the main system prompt\./,
    ]);
    // It opens on the mode that is in effect.
    await expect(menu.getByRole('option', { selected: true })).toHaveText(/^Coding/);

    await page.keyboard.type('plan');
    await expect(menu.getByRole('option')).toHaveText([/^Planning/]);
    await page.keyboard.press('Enter');

    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveText('');
    await expect(composer).toBeFocused();
    await expect(
      page.locator('app-composer').getByRole('button', { name: 'Planning' }),
    ).toBeVisible();
    expect((await app.backend.lastCall('update_session'))?.args).toMatchObject({
      sessionId: 'session-1',
      modeId: 'planning',
    });
    expect(await app.backend.calls('send_message')).toEqual([]);
  });

  test('the mode hotkey switches between planning and the mode before it', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start, {
      sessions: [session({ title: 'New session', modeId: 'nacked' })],
      settings: { ...seed().settings, modes: MODES },
    });
    const picker = (name: string) => page.locator('app-composer').getByRole('button', { name });

    await expect(picker('Nacked')).toBeVisible();
    await composer.click();
    await page.keyboard.type('Half a prompt');
    await page.keyboard.press(TOGGLE_MODE);
    await expect(picker('Planning')).toBeVisible();
    expect((await app.backend.lastCall('update_session'))?.args).toMatchObject({
      sessionId: 'session-1',
      modeId: 'planning',
    });

    // Back to the mode it left, not to coding; the draft is untouched.
    await page.keyboard.press(TOGGLE_MODE);
    await expect(picker('Nacked')).toBeVisible();
    await expect(composer).toHaveText('Half a prompt');
    expect(await app.backend.calls('send_message')).toEqual([]);

    // It works wherever the focus is.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press(TOGGLE_MODE);
    await expect(picker('Planning')).toBeVisible();
  });

  test('/model switches to the model that matches what is typed', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      models: [
        model(),
        model('anthropic/claude-opus-5', 'Claude Opus 5'),
        model('openai/gpt-5', 'GPT-5'),
      ],
    });
    const menu = page.getByRole('listbox');

    await composer.click();
    await page.keyboard.type('/model ');
    await expect(menu.getByRole('option')).toHaveCount(3);
    await expect(menu.getByRole('option', { selected: true })).toContainText('Claude Sonnet 5');

    await page.keyboard.type('opus');
    await expect(menu.getByRole('option')).toHaveText([/Claude Opus 5/]);
    await page.keyboard.press('Enter');

    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveText('');
    await expect(page.locator('app-composer')).toContainText('Claude Opus 5');
    expect((await app.backend.lastCall('update_session'))?.args).toMatchObject({
      sessionId: 'session-1',
      model: 'anthropic/claude-opus-5',
    });

    // The next prompt goes to the new model.
    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    expect((await app.backend.waitForCall('send_message')).args).toMatchObject({
      content: 'Hello',
      model: 'anthropic/claude-opus-5',
    });
  });

  test('/model says so when nothing matches and does not send the line', async ({ app, page }) => {
    const composer = await openSession(page, app.start);
    const menu = page.getByRole('listbox');

    await composer.click();
    await page.keyboard.type('/model nothing like this');
    await expect(menu).toContainText('No matches');
    await page.keyboard.press('Enter');

    await expect(composer).toHaveText('/model nothing like this');
    expect(await app.backend.calls('send_message')).toEqual([]);
    expect(await app.backend.calls('update_session')).toEqual([]);
  });

  test('/provider routes the model to the picked provider', async ({ app, page }) => {
    const composer = await openSession(page, app.start);
    const menu = page.getByRole('listbox');

    await composer.click();
    await page.keyboard.type('/prov');
    await page.keyboard.press('Tab');
    await expect(menu.getByRole('option', { selected: true })).toHaveText('Auto (best available)');
    await expect(menu.getByRole('option')).toContainText([
      'Auto (best available)',
      'Best tokens/sec',
      'Cheapest provider',
      'Best price-performance',
    ]);

    await page.keyboard.type('cheap');
    await page.keyboard.press('Enter');

    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveText('');
    await expect(page.locator('app-composer')).toContainText('Cheapest provider');
    expect((await app.backend.lastCall('update_session'))?.args).toMatchObject({
      sessionId: 'session-1',
      provider: 'auto:price',
    });
  });

  test('/provider shows each provider as the provider menu does and picks one', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start, {
      endpoints: [
        endpoint('Anthropic', 'anthropic'),
        endpoint('Amazon Bedrock', 'amazon-bedrock/us-east', {
          promptPricePerM: 3.3,
          uptimeLast30m: 96.2,
          throughputLast30m: 61,
          latencyLast30m: 910,
        }),
        endpoint('DeepTrain', 'deeptrain/fp8', { training: true, quantization: 'fp8' }),
      ],
    });
    const menu = page.getByRole('listbox');

    await composer.click();
    await page.keyboard.type('/provider ');
    await expect(menu.getByRole('option')).toHaveCount(7);

    // Price, health, speed, context and region of each one.
    const bedrock = menu.getByRole('option', { name: /Amazon Bedrock/ });
    for (const detail of ['$3.30 / $15.00', '96.2%', '61 tok/s', '910 ms', '200k', 'us-east']) {
      await expect(bedrock).toContainText(detail);
    }
    const trains = menu.getByRole('option', { name: /DeepTrain/ });
    await expect(trains).toContainText('trains on data');
    await expect(trains).toContainText('fp8');

    await page.keyboard.type('bed');
    await expect(menu.getByRole('option')).toHaveText([/Amazon Bedrock/]);
    await page.keyboard.press('Enter');

    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveText('');
    await expect(page.locator('app-composer')).toContainText('Amazon Bedrock');
    expect((await app.backend.lastCall('update_session'))?.args).toMatchObject({
      sessionId: 'session-1',
      provider: 'amazon-bedrock',
    });

    // The provider menu of the toolbar still lists the same rows.
    await page.getByRole('button', { name: 'Amazon Bedrock' }).click();
    const toolbarMenu = page.locator('#composer-provider-menu');
    await expect(toolbarMenu).toContainText('61 tok/s');
    await expect(toolbarMenu).toContainText('trains on data');
  });

  test('a provider the OpenRouter account blocks is listed but cannot be picked', async ({
    app,
    page,
  }) => {
    const reason =
      'No endpoints found matching your data policy (Paid model training). Configure: https://openrouter.ai/settings/privacy';
    const composer = await openSession(page, app.start, {
      endpoints: [
        endpoint('Anthropic', 'anthropic'),
        endpoint('DeepTrain', 'deeptrain/fp8', { blocked: true, blockedReason: reason }),
        // Blocked without a word from OpenRouter on why.
        endpoint('Quiet', 'quiet', { blocked: true }),
      ],
    });

    await page.getByRole('button', { name: 'Auto (best available)' }).click();
    const toolbarMenu = page.locator('#composer-provider-menu');
    const blocked = toolbarMenu.getByRole('button', { name: /DeepTrain/ });
    await expect(blocked).toContainText('blocked');
    await expect(blocked).toBeDisabled();
    await expect(blocked).toHaveAttribute('title', reason);
    await expect(toolbarMenu.getByRole('button', { name: /Quiet/ })).toHaveAttribute(
      'title',
      'Your OpenRouter privacy or provider settings block this provider.',
    );
    const allowed = toolbarMenu.getByRole('button', { name: /Anthropic/ });
    await expect(allowed).toBeEnabled();
    await expect(allowed).not.toContainText('blocked');
    await page.keyboard.press('Escape');
    await expect(toolbarMenu).toHaveCount(0);

    // `/provider` lists it the same way, and neither Enter nor a click picks it.
    await composer.click();
    await page.keyboard.type('/provider deep');
    const option = page.getByRole('listbox').getByRole('option', { name: /DeepTrain/ });
    await expect(option).toContainText('blocked');
    await expect(option).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Enter');
    // Playwright itself holds back from a disabled option; the app must too.
    await option.click({ force: true });
    await expect(option).toBeVisible();
    expect(await app.backend.calls('update_session')).toEqual([]);
  });

  test('a session pinned to a provider that is now blocked leaves the routing to OpenRouter', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start, {
      sessions: [session({ title: 'New session', provider: 'deeptrain' })],
      endpoints: [
        endpoint('Anthropic', 'anthropic'),
        endpoint('DeepTrain', 'deeptrain/fp8', { blocked: true }),
      ],
    });

    const chip = page.getByRole('button', { name: 'DeepTrain' });
    await expect(chip).toHaveAttribute(
      'title',
      'Your OpenRouter privacy or provider settings block this provider.',
    );

    await composer.click();
    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    const call = await app.backend.waitForCall('send_message');
    expect(call?.args).toMatchObject({ content: 'Hello' });
    expect(call?.args['provider'] ?? null).toBeNull();
  });

  test('/provider explains that a direct model has no provider to pick', async ({ app, page }) => {
    const direct = 'anthropic:claude-sonnet-5';
    const composer = await openSession(page, app.start, {
      apiKeys: ['anthropic'],
      models: [model(direct, 'Claude Sonnet 5')],
      sessions: [session({ title: 'New session', model: direct })],
    });

    await composer.click();
    await page.keyboard.type('/provider ');
    await expect(page.getByRole('listbox')).toHaveText(
      'Only OpenRouter models can be routed to a provider.',
    );
    await page.keyboard.press('Enter');
    expect(await app.backend.calls('send_message')).toEqual([]);
  });

  test('/code-review calls the prompt of that name for one message', async ({ app, page }) => {
    const composer = await openSession(page, app.start);

    await composer.click();
    await page.keyboard.type('/code');
    // The first Enter completes the name, so a review never starts by accident.
    await page.keyboard.press('Enter');
    await expect(composer).toHaveText('/code-review ');
    expect(await app.backend.calls('send_message')).toEqual([]);

    await page.keyboard.type('src/auth');
    await page.keyboard.press('Enter');

    // The chat keeps the line as typed; the backend adds the prompt it names.
    expect((await app.backend.waitForCall('send_message')).args).toMatchObject({
      sessionId: 'session-1',
      content: '/code-review src/auth',
      promptId: 'code-review',
      model: MODEL_ID,
    });
    await expect(page.getByRole('main')).toContainText('Echo: /code-review src/auth');

    // The message after it is an ordinary one again.
    await page.keyboard.type('Thanks');
    await page.keyboard.press('Enter');
    expect((await app.backend.waitForCall('send_message', 2)).args).not.toHaveProperty('promptId');
  });

  test('a prompt runs at once when its whole name is typed', async ({ app, page }) => {
    const composer = await openSession(page, app.start);

    await composer.click();
    await page.keyboard.type('/release-notes');
    await page.keyboard.press('Enter');

    expect((await app.backend.waitForCall('send_message')).args).toMatchObject({
      content: '/release-notes',
      promptId: 'custom-1',
    });
  });

  test('the prompts panel shows how each prompt is called instead of switching it on', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start);
    const panel = page.locator('app-system-prompts-panel');

    await page.getByRole('button', { name: 'System prompts' }).click();
    await expect(panel).toContainText('Call a prompt from the chat box with a slash and its name');
    await expect(panel.getByTestId('prompt-command')).toHaveText(['/code-review', '/release-notes']);
    // Only the three built-in prompts of every session are switched on and off.
    await expect(panel.getByRole('switch')).toHaveCount(3);

    // A new prompt is called by the name it is given, once it has text.
    await panel.getByRole('button', { name: 'New' }).click();
    await panel.getByPlaceholder('Prompt name').fill('Explain simply');
    await panel.getByPlaceholder('Prompt name').blur();
    await expect(panel.getByTestId('prompt-command')).toHaveText([
      '/code-review',
      '/release-notes',
      '/explain-simply',
    ]);
    await panel.locator('textarea').fill('Explain it to a newcomer.');
    await panel.locator('textarea').blur();

    await composer.click();
    await page.keyboard.type('/explain-simply');
    await page.keyboard.press('Enter');
    const saved = (await app.backend.state()).settings.userSystemPrompts.at(-1);
    expect(saved).toMatchObject({ name: 'Explain simply', prompt: 'Explain it to a newcomer.' });
    expect((await app.backend.waitForCall('send_message')).args).toMatchObject({
      content: '/explain-simply',
      promptId: saved!.id,
    });
  });

  test('/revert goes back to the last prompt once it is confirmed', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [
        { steps: [{ kind: 'text', text: 'First answer' }] },
        { steps: [{ kind: 'text', text: 'Second answer' }] },
      ],
    });
    const main = page.getByRole('main');
    const menu = page.getByRole('listbox');
    const dialog = page.getByRole('dialog');

    // Nothing to go back to yet: the menu says so and Enter leaves the line.
    await composer.click();
    await page.keyboard.type('/revert');
    await expect(menu).toContainText('There is no prompt to go back to yet');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(composer).toHaveText('/revert');

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('First prompt');
    await page.keyboard.press('Enter');
    await expect(main).toContainText('First answer');
    await page.keyboard.type('Second prompt');
    await page.keyboard.press('Enter');
    await expect(main).toContainText('Second answer');

    await page.keyboard.type('/rev');
    await expect(menu).toContainText('Go back to your last prompt');
    await page.keyboard.press('Enter');
    await expect(dialog).toContainText('Revert conversation to this prompt?');
    await expect(dialog).toContainText('Second prompt');
    await expect(composer).toHaveText('');

    // Escape cancels and returns to the chat box; nothing was taken back.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(composer).toBeFocused();
    expect(await app.backend.calls('revert_to_message')).toEqual([]);

    // The dialog opens on its confirm button, so a second Enter reverts.
    await page.keyboard.type('/revert');
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('button', { name: 'Revert' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(dialog).toHaveCount(0);
    await expect(main).not.toContainText('Second answer');
    await expect(main).toContainText('First answer');
    expect((await app.backend.lastCall('revert_to_message'))?.args).toMatchObject({
      restoreFiles: true,
    });
    expect((await app.backend.state()).messages.map((entry) => entry.content)).toEqual([
      'First prompt',
      'First answer',
    ]);

    // The prompt is back in the chat box with the caret behind it.
    await expect(composer).toHaveText('Second prompt');
    await expect(composer).toBeFocused();
    await page.keyboard.type(', again');
    await expect(composer).toHaveText('Second prompt, again');
    expect(await app.backend.calls('send_message')).toHaveLength(2);
  });

  test('/revert waits until the agent has stopped', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [{ steps: [{ kind: 'text', text: 'Working on it' }, { kind: 'hang' }] }],
    });

    await composer.click();
    await page.keyboard.type('Start the task');
    await page.keyboard.press('Enter');
    await expect(page.locator('app-composer').getByRole('button', { name: 'Stop' })).toBeVisible();

    await page.keyboard.type('/revert');
    await expect(page.getByRole('listbox')).toContainText('Stop the agent first');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(composer).toHaveText('/revert');
    await expect(page.getByText('Queued (1)')).toHaveCount(0);
    expect(await app.backend.calls('send_message')).toHaveLength(1);
  });
});
