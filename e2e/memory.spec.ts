import type { Page } from '@playwright/test';
import type { FakeReply, FakeSeed } from './support/fake-backend';
import type { MemoryEntry } from '../src/app/core/models';
import { expect, project, seed, session, test, type PumrApp } from './support/fixtures';

const PREFERENCE = 'When reviewing code, ask me for every finding whether to fix or skip it.';

/** A turn in which the agent proposes `PREFERENCE` for the memory. */
const PROPOSING: FakeReply = {
  steps: [
    { kind: 'memory', text: PREFERENCE },
    { kind: 'text', text: 'Here is the review.' },
  ],
};

function entry(id: string, text: string): MemoryEntry {
  return { id, text };
}

/** Opens the chat of `session-1` and returns its chat box. */
async function openChat(page: Page, app: PumrApp, patch: Partial<FakeSeed> = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
    localStorage.setItem('pumr.activeTab', 'session-1');
  });
  await app.start(seed({ projects: [project()], sessions: [session()], ...patch }));
  return page.getByRole('textbox', { name: /Describe your task/ });
}

async function send(page: Page, prompt: string) {
  await page.getByRole('textbox', { name: /Describe your task/ }).click();
  await page.keyboard.type(prompt);
  await page.keyboard.press('Enter');
}

async function openMemorySettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Memory', exact: true }).click();
  return dialog;
}

test.describe('memory', () => {
  test('offers to remember a preference once the answer is there', async ({ app, page }) => {
    await openChat(page, app, { replies: [PROPOSING] });
    await send(page, 'Review the code, but ask me for every finding');

    await expect(page.getByRole('main')).toContainText('Here is the review.');
    const card = page.getByTestId('memory-card');
    await expect(card).toBeInViewport();
    await expect(card).toContainText('Remember this?');
    await expect(card).toContainText('pumr noticed this in your message.');
    await expect(card.getByRole('textbox', { name: 'What to remember' })).toHaveValue(PREFERENCE);
    // The call itself shows in the chat with what was proposed.
    await expect(page.getByRole('main')).toContainText('remember');

    await card.getByRole('button', { name: 'Remember', exact: true }).click();

    await expect(card).toHaveCount(0);
    expect((await app.backend.lastCall('resolve_memory_suggestion'))?.args).toMatchObject({
      sessionId: 'session-1',
      decision: 'save',
      text: PREFERENCE,
    });
    expect((await app.backend.state()).settings.memories).toEqual([
      expect.objectContaining({ text: PREFERENCE }),
    ]);

    // The settings list what is remembered.
    const dialog = await openMemorySettings(page);
    await expect(dialog.getByTestId('memory-entry')).toHaveCount(1);
    await expect(dialog.getByTestId('memory-entry').getByRole('textbox')).toHaveValue(PREFERENCE);
  });

  test('remembers the text as the user edited it', async ({ app, page }) => {
    await openChat(page, app, { replies: [PROPOSING] });
    await send(page, 'Review the code');

    const card = page.getByTestId('memory-card');
    await card.getByRole('textbox', { name: 'What to remember' }).fill('Ask before every fix.');
    await card.getByRole('button', { name: 'Remember', exact: true }).click();

    await expect(card).toHaveCount(0);
    expect((await app.backend.state()).settings.memories).toEqual([
      expect.objectContaining({ text: 'Ask before every fix.' }),
    ]);
  });

  test('keeps nothing when the user says no', async ({ app, page }) => {
    await openChat(page, app, { replies: [PROPOSING] });
    await send(page, 'Review the code');

    const card = page.getByTestId('memory-card');
    await card.getByRole('button', { name: 'No thanks' }).click();

    await expect(card).toHaveCount(0);
    expect((await app.backend.lastCall('resolve_memory_suggestion'))?.args).toMatchObject({
      decision: 'decline',
      text: null,
    });
    const settings = (await app.backend.state()).settings;
    expect(settings.memories).toEqual([]);
    expect(settings.memorySuggestions).toBe(true);
  });

  test("switches the suggestions off with Don't ask again", async ({ app, page }) => {
    await openChat(page, app, { replies: [PROPOSING] });
    await send(page, 'Review the code');

    const card = page.getByTestId('memory-card');
    await card.getByRole('button', { name: "Don't ask again" }).click();

    await expect(card).toHaveCount(0);
    expect((await app.backend.lastCall('resolve_memory_suggestion'))?.args).toMatchObject({
      decision: 'disable',
    });
    const settings = (await app.backend.state()).settings;
    expect(settings.memorySuggestions).toBe(false);
    expect(settings.memoryEnabled).toBe(true);

    // The switch in the settings follows, and the memory itself stays on.
    const dialog = await openMemorySettings(page);
    await expect(dialog.getByTestId('memory-suggestions').getByRole('switch')).not.toBeChecked();
    await expect(dialog.getByTestId('memory-enabled').getByRole('switch')).toBeChecked();
  });

  test('waits with the card until the turn is over', async ({ app, page }) => {
    await openChat(page, app, {
      replies: [
        {
          steps: [
            { kind: 'memory', text: PREFERENCE },
            { kind: 'text', text: 'Reading the diff.' },
            { kind: 'pause' },
            { kind: 'text', text: ' Here is the review.' },
          ],
        },
      ],
    });
    await send(page, 'Review the code');

    await expect(page.getByRole('main')).toContainText('Reading the diff.');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(page.getByTestId('memory-card')).toHaveCount(0);

    await app.backend.resume();

    await expect(page.getByRole('main')).toContainText('Here is the review.');
    await expect(page.getByTestId('memory-card')).toBeVisible();
  });

  test('keeps the card through a queued prompt and a reload', async ({ app, page }) => {
    const composer = await openChat(page, app, {
      replies: [
        {
          steps: [
            { kind: 'memory', text: PREFERENCE },
            { kind: 'text', text: 'First' },
            { kind: 'hang' },
          ],
        },
        { steps: [{ kind: 'text', text: 'Second task done' }] },
      ],
    });
    await send(page, 'Review the code');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();

    await composer.click();
    await page.keyboard.type('Second task');
    await page.getByRole('button', { name: 'Queue' }).click();
    await page.getByRole('button', { name: 'Stop' }).click();

    // The queued prompt started the moment the first turn ended.
    await expect(page.getByRole('main')).toContainText('Second task done');
    const card = page.getByTestId('memory-card');
    await expect(card.getByRole('textbox', { name: 'What to remember' })).toHaveValue(PREFERENCE);

    await page.reload();
    await expect(page.getByTestId('splash')).toHaveCount(0);
    await expect(card.getByRole('textbox', { name: 'What to remember' })).toHaveValue(PREFERENCE);
  });

  test('shows what a correction replaces and that the user asked for it', async ({ app, page }) => {
    const initial = seed({
      projects: [project()],
      sessions: [session()],
      replies: [
        {
          steps: [
            {
              kind: 'memory',
              text: 'Keep answers to one paragraph.',
              requested: true,
              replaces: entry('memory-1', 'Keep answers short.'),
            },
            { kind: 'text', text: 'Noted.' },
          ],
        },
      ],
    });
    initial.settings.memories = [
      entry('memory-1', 'Keep answers short.'),
      entry('memory-2', 'Use tabs.'),
    ];
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await app.start(initial);
    await send(page, 'Remember that I want one paragraph at most');

    const card = page.getByTestId('memory-card');
    await expect(card).toContainText('You asked pumr to remember this.');
    await expect(card.getByTestId('memory-replaces')).toHaveText('Replaces: Keep answers short.');

    await card.getByRole('button', { name: 'Remember', exact: true }).click();

    await expect(card).toHaveCount(0);
    expect((await app.backend.state()).settings.memories).toEqual([
      entry('memory-1', 'Keep answers to one paragraph.'),
      entry('memory-2', 'Use tabs.'),
    ]);
  });

  test('takes a suggestion back with the prompt it came from', async ({ app, page }) => {
    await openChat(page, app, { replies: [PROPOSING] });
    await send(page, 'Review the code');
    await expect(page.getByTestId('memory-card')).toBeVisible();

    await page.getByRole('button', { name: 'Revert to this prompt' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revert', exact: true }).click();

    await expect(page.getByRole('main')).not.toContainText('Here is the review.');
    await expect(page.getByTestId('memory-card')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('splash')).toHaveCount(0);
    await expect(page.getByTestId('memory-card')).toHaveCount(0);
  });

  test('leaves the card out while the memory is switched off', async ({ app, page }) => {
    const initial = seed({ projects: [project()], sessions: [session()], replies: [PROPOSING] });
    initial.settings.memoryEnabled = false;
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await app.start(initial);
    await send(page, 'Review the code');

    await expect(page.getByRole('main')).toContainText('Here is the review.');
    await expect(page.getByTestId('memory-card')).toHaveCount(0);
  });

  test('edits what is remembered in the settings', async ({ app, page }) => {
    const initial = seed();
    initial.settings.memories = [
      entry('memory-1', 'Keep answers short.'),
      entry('memory-2', 'Use tabs.'),
    ];
    await app.start(initial);

    const dialog = await openMemorySettings(page);
    const entries = dialog.getByTestId('memory-entry');
    await expect(entries).toHaveCount(2);
    await expect(dialog.getByTestId('memory-count')).toHaveText('2/30');

    await entries.nth(0).getByRole('textbox').fill('Keep answers to one paragraph.');
    await entries.nth(1).getByRole('button', { name: 'Remove entry' }).click();
    await expect(entries).toHaveCount(1);
    await dialog.getByTestId('add-memory').click();
    await entries.nth(1).getByRole('textbox').fill('Never commit unless I say so.');
    // An entry left empty is not kept.
    await dialog.getByTestId('add-memory').click();
    await expect(entries).toHaveCount(3);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await app.backend.waitForCall('save_settings');
    expect((await app.backend.state()).settings.memories).toEqual([
      entry('memory-1', 'Keep answers to one paragraph.'),
      expect.objectContaining({ text: 'Never commit unless I say so.' }),
    ]);
  });

  test('switches the memory and its suggestions off in the settings', async ({ app, page }) => {
    await app.start();

    const dialog = await openMemorySettings(page);
    await expect(dialog.getByTestId('no-memories')).toBeVisible();
    const enabled = dialog.getByTestId('memory-enabled').getByRole('switch');
    const suggestions = dialog.getByTestId('memory-suggestions').getByRole('switch');
    await expect(enabled).toBeChecked();
    await expect(suggestions).toBeChecked();

    await suggestions.click();
    await expect(suggestions).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const saved = await app.backend.waitForCall('save_settings');
    expect(saved.args['settings']).toMatchObject({ memoryEnabled: true, memorySuggestions: false });

    // Without the memory there is nothing to suggest for.
    await enabled.click();
    await expect(suggestions).toBeDisabled();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const off = await app.backend.waitForCall('save_settings', 2);
    expect(off.args['settings']).toMatchObject({ memoryEnabled: false });
  });
});
