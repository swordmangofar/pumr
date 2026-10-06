import type { Page } from '@playwright/test';
import { expect, project, seed, session, test } from './support/fixtures';
import type { FakeSeed } from './support/fake-backend';

const ISSUE =
  "MCP server 'codegraph' stopped during initialize: exit status: 127. Last error output: env: node: No such file or directory (/home/dev/.config/opencode/opencode.jsonc)";

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

async function send(page: Page, composer: ReturnType<Page['getByRole']>, text: string) {
  await composer.click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test.describe('MCP servers of a turn', () => {
  test('names the server a turn waits for, then what it has to do without', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start, {
      replies: [
        {
          mcp: { server: 'codegraph', issues: [ISSUE] },
          steps: [{ kind: 'text', text: 'Described without the code graph.' }],
        },
        { steps: [{ kind: 'text', text: 'Second answer.' }] },
      ],
    });
    const main = page.getByRole('main');
    const starting = main.getByTestId('chat-mcp-starting');
    const issues = main.getByTestId('chat-mcp-issues');

    await send(page, composer, 'Describe this merge request');
    await expect(starting).toHaveText(/Starting MCP server codegraph/);
    // The wait has a name; it is not passed off as the model thinking.
    await expect(main.getByText('Thinking')).toHaveCount(0);
    await expect(issues).toHaveCount(0);

    await app.backend.resume();
    await expect(starting).toHaveCount(0);
    await expect(issues).toContainText('Some MCP servers could not be used for this message');
    await expect(issues).toContainText('exit status: 127');
    await expect(issues).toContainText('env: node: No such file or directory');
    await expect(main).toContainText('Described without the code graph.');
    // It stays readable once the turn is over, until the chat goes on.
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    await expect(issues).toBeVisible();

    await send(page, composer, 'Thanks');
    await expect(main).toContainText('Second answer.');
    await expect(issues).toHaveCount(0);
  });

  test('Stop ends the wait for a server', async ({ app, page }) => {
    const composer = await openSession(page, app.start, {
      replies: [{ mcp: { server: 'slow' }, steps: [{ kind: 'text', text: 'Never said.' }] }],
    });
    const main = page.getByRole('main');
    const starting = main.getByTestId('chat-mcp-starting');

    await send(page, composer, 'Use the slow server');
    await expect(starting).toHaveText(/Starting MCP server slow/);

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(starting).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
    await expect(main).not.toContainText('Never said.');
    await expect(main.getByTestId('chat-mcp-issues')).toHaveCount(0);
  });
});
