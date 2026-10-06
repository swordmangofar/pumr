import type { FakeReply, FakeStep } from './support/fake-backend';
import { expect, project, seed, session, test, type PumrApp } from './support/fixtures';
import type { Page } from '@playwright/test';

const explore = {
  server: 'codegraph',
  tool: 'codegraph_explore',
  source: '/home/me/.config/opencode/opencode.json',
  fingerprint: 'aaaa',
};

/** A call of the codegraph tool, as the agent loop asks about it. */
function exploreCall(query: string): FakeStep {
  return {
    kind: 'permission',
    title: 'Run MCP tool mcp__codegraph__codegraph_explore?',
    command: JSON.stringify({ tool: 'mcp__codegraph__codegraph_explore', arguments: { query } }),
    request: { mcpTool: explore },
  };
}

async function sendWithReply(page: Page, app: PumrApp, reply: FakeReply) {
  await page.addInitScript(() => {
    localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
    localStorage.setItem('pumr.activeTab', 'session-1');
  });
  await app.start(seed({ projects: [project()], sessions: [session()], replies: [reply] }));
  await page.getByRole('textbox', { name: /Describe your task/ }).click();
  await page.keyboard.type('How is the total computed?');
  await page.keyboard.press('Enter');
}

test.describe('MCP tool approvals', () => {
  test('a tool allowed for the chat is not asked about again', async ({ app, page }) => {
    await sendWithReply(page, app, {
      steps: [
        exploreCall('total'),
        exploreCall('applyTax'),
        { kind: 'text', text: 'The total is the subtotal plus tax.' },
      ],
    });

    const prompt = page.getByRole('dialog');
    await expect(prompt.getByText('"query":"total"').first()).toBeVisible();
    // Next to Yes and No: stop asking for this tool, in this chat or for good.
    await expect(prompt.getByTestId('options').getByRole('button')).toHaveCount(4);
    await expect(prompt.getByTestId('mcp-tool-hint')).toContainText('whatever its arguments');
    // The preselected choice is a plain Yes, although commands preselect
    // "don't ask again": a tool that runs outside the command checks is
    // remembered only when the user picks that.
    const remember = prompt.getByRole('button', {
      name: "Yes, and don't ask again in this chat for codegraph_explore (codegraph)",
    });
    await expect(prompt.getByRole('button', { name: /^1 Yes$/ })).toHaveClass(/border-accent\/60/);
    await expect(remember).not.toHaveClass(/border-accent\/60/);

    await remember.click();

    // The second call has other arguments and still runs without a prompt.
    await expect(page.getByRole('main')).toContainText('The total is the subtotal plus tax.');
    await expect(prompt).toHaveCount(0);
    const decisions = await app.backend.calls('resolve_permission');
    expect(decisions.map((call) => call.args['decision'])).toEqual(['allow_session']);
    // Nothing was saved: the approval lasts as long as the chat.
    expect((await app.backend.state()).settings.mcpToolGrants).toEqual([]);
  });

  test('an always-allowed tool is listed in the settings and can be removed', async ({
    app,
    page,
  }) => {
    await sendWithReply(page, app, {
      steps: [exploreCall('total'), { kind: 'text', text: 'Done.' }],
    });

    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Yes, and always allow codegraph_explore (codegraph)' })
      .click();
    await expect(page.getByRole('main')).toContainText('Done.');
    expect((await app.backend.state()).settings.mcpToolGrants).toEqual([explore]);

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Agent white- and blacklist' }).click();
    const grants = dialog.getByTestId('mcp-tool-grants');
    const grant = grants.getByTestId('mcp-tool-grant');
    await expect(grant).toHaveCount(1);
    await expect(grant).toContainText('codegraph_explore');
    await expect(grant).toContainText('/home/me/.config/opencode/opencode.json');

    await grant.getByRole('button').click();
    await expect(grants).toContainText('No always-allowed MCP tools yet.');
    expect((await app.backend.lastCall('delete_mcp_tool_grant'))?.args['grant']).toEqual(explore);
    expect((await app.backend.state()).settings.mcpToolGrants).toEqual([]);
  });
});
