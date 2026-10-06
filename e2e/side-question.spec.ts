import type { Page } from '@playwright/test';
import { expect, MODEL_ID, project, seed, session, test } from './support/fixtures';
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

test.describe('side question (/btw)', () => {
  test('offers /btw after a slash and answers below the chat box', async ({ app, page }) => {
    const composer = await openSession(page, app.start);
    const answer = page.getByTestId('side-answer');

    await composer.click();
    await page.keyboard.type('/');
    const menu = page.locator('#composer-command-menu');
    await expect(menu).toContainText('/btw');
    await expect(menu).toContainText('Ask a quick question about this session');

    // Enter completes the command instead of sending the slash.
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveText('/btw ');
    await page.keyboard.type('What does **verify** run?');
    await page.keyboard.press('Enter');

    await expect(answer).toContainText('Side answer: What does verify run?');
    await expect(answer.locator('strong', { hasText: 'verify' })).toBeVisible();
    await expect(answer).toContainText('Not added to the session');
    await expect(composer).toHaveText('');
    await expect(composer).toBeFocused();

    // The answer sits under the chat box, where the terminal docks.
    const composerBox = await composer.boundingBox();
    const answerBox = await answer.boundingBox();
    expect(answerBox!.y).toBeGreaterThan(composerBox!.y + composerBox!.height);

    expect((await app.backend.lastCall('ask_side_question'))?.args).toMatchObject({
      sessionId: 'session-1',
      question: 'What does **verify** run?',
      model: MODEL_ID,
    });
    // Nothing reached the session: no turn, no messages, no renamed tab.
    expect(await app.backend.calls('send_message')).toEqual([]);
    expect((await app.backend.state()).messages).toEqual([]);
    await expect(page.getByRole('main')).not.toContainText('Echo:');

    await answer.getByRole('button', { name: 'Close' }).click();
    await expect(answer).toHaveCount(0);
    await expect(composer).toBeFocused();
  });

  test('answers while a turn is running instead of queueing the question', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start, {
      replies: [{ steps: [{ kind: 'text', text: 'Working on the task' }, { kind: 'hang' }] }],
    });
    const answer = page.getByTestId('side-answer');
    // The turn's Stop button; an answer that streams has one of its own.
    const stop = page.locator('app-composer').getByRole('button', { name: 'Stop' });

    await composer.click();
    await page.keyboard.type('Start the task');
    await page.keyboard.press('Enter');
    await expect(stop).toBeVisible();

    await composer.click();
    await page.keyboard.type('/btw how far is it?');
    await page.keyboard.press('Enter');

    await expect(answer).toContainText('Side answer: how far is it?');
    await expect(page.getByText('Queued (1)')).toHaveCount(0);
    expect(await app.backend.calls('send_message')).toHaveLength(1);

    // Escape closes the answer first and leaves the turn running.
    await composer.click();
    await page.keyboard.press('Escape');
    await expect(answer).toHaveCount(0);
    await expect(stop).toBeVisible();
    expect(await app.backend.calls('stop_generation')).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    expect((await app.backend.lastCall('stop_generation'))?.args).toEqual({
      sessionId: 'session-1',
    });
  });

  test('stops an answer that is still streaming', async ({ app, page }) => {
    const composer = await openSession(page, app.start, { chunkDelayMs: 400 });
    const answer = page.getByTestId('side-answer');

    await composer.click();
    await page.keyboard.type('/btw explain the whole architecture in detail please');
    await page.keyboard.press('Enter');
    await expect(answer).toContainText('Side answer:');

    await answer.getByRole('button', { name: 'Stop' }).click();

    await expect(answer).toContainText('Stopped');
    // What had arrived stays; the rest of the answer never does.
    await expect(answer.locator('app-markdown')).toHaveText('Side answer:');
    expect((await app.backend.lastCall('stop_generation'))?.args).toEqual({
      sessionId: 'side-question:session-1',
    });
  });

  test('sends a prompt that only looks like a command', async ({ app, page }) => {
    const composer = await openSession(page, app.start);

    await composer.click();
    await page.keyboard.type('/btwice is not a command');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('main')).toContainText('Echo: /btwice is not a command');
    expect(await app.backend.calls('ask_side_question')).toEqual([]);
  });
});
