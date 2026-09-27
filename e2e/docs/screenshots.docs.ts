import { expect, test, type Browser, type Page } from '@playwright/test';
import type { FakeStep } from '../support/fake-backend';
import {
  capture,
  CHECKOUT_PROMPT,
  CHECKOUT_REPLY,
  DEMO_CHANGES,
  DEMO_DIFFS,
  DEMO_ENDPOINTS,
  DEMO_MCP,
  DEMO_SKILLS,
  DEMO_USER_PROMPTS,
  DEMO_WORKSPACE,
  sendPrompt,
  startDemo,
  waitForTurn,
} from './demo';

const REVIEW = { get_session_changes: DEMO_CHANGES, get_file_diff: DEMO_DIFFS };

/** Lays `shots` (2x captures) side by side at `width` CSS pixels each. */
async function composeRow(browser: Browser, file: string, shots: Buffer[], width: number) {
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await context.newPage();
  const images = shots
    .map((png) => `<img src="data:image/png;base64,${png.toString('base64')}">`)
    .join('');
  await page.setContent(`
    <style>
      body { margin: 0; background: transparent; }
      #row { display: flex; gap: 20px; width: max-content; align-items: flex-start; }
      img { display: block; width: ${width}px; border-radius: 16px; }
    </style>
    <div id="row">${images}</div>`);
  await page.locator('#row').screenshot({ path: `docs/${file}`, omitBackground: true });
  await context.close();
}

async function openDiff(page: Page) {
  await page.locator('app-right-panel').getByText('src/routes/checkout.ts').first().click();
  await page.locator('.view-lines').first().waitFor();
}

test('hero', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await startDemo(page, {
    seed: { replies: [CHECKOUT_REPLY] },
    overrides: { ...REVIEW, list_workspace_entries: DEMO_WORKSPACE },
  });
  await sendPrompt(page, CHECKOUT_PROMPT);
  await waitForTurn(page);
  await openDiff(page);
  await page.getByRole('textbox', { name: /Describe your task/ }).click();
  await page.keyboard.type('Add a refund route next to @file:routes/check');
  await capture(page, 'screenshot.png', undefined, { keepFocus: true });
});

test('agent and chat', async ({ page }) => {
  const steps = CHECKOUT_REPLY.steps.filter((step) => step.kind !== 'text');
  const running: FakeStep[] = [...steps.slice(0, 4), { kind: 'hang' }];
  await startDemo(page, { seed: { replies: [{ steps: running }] }, overrides: REVIEW });
  await sendPrompt(page, CHECKOUT_PROMPT);
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await page.getByText('Thinking process').first().click();
  await capture(page, 'features/agent-chat.png', page.locator('app-chat-view'));
});

test('tools and permissions', async ({ page }) => {
  await startDemo(page, {
    seed: {
      replies: [
        {
          steps: [
            ...CHECKOUT_REPLY.steps.slice(5, 7),
            {
              kind: 'permission',
              command: 'git push origin feat/checkout',
              title: 'Push to the remote?',
              justification: 'Publish the checkout branch so CI can run the tests.',
              request: {
                title: 'Push to the remote?',
                detail: 'git push contacts github.com and publishes commits.',
                risk: { level: 'network', detail: 'Contacts github.com' },
                suggestedRule: 'git push *',
                scopeOptions: [
                  { kind: 'subcommand', rule: { kind: 'glob', value: 'git push *' } },
                  {
                    kind: 'exact',
                    rule: { kind: 'exact', value: 'git push origin feat/checkout' },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  });
  await sendPrompt(page, 'Commit the checkout work and push the branch.');
  await page.getByRole('dialog').getByText('git push origin feat/checkout').first().waitFor();
  await capture(page, 'features/tools-permissions.png', page.locator('app-chat-view'));
});

test('diffs, history and context', async ({ page }) => {
  await startDemo(page, { seed: { replies: [CHECKOUT_REPLY] }, overrides: REVIEW });
  await sendPrompt(page, CHECKOUT_PROMPT);
  await waitForTurn(page);
  await openDiff(page);
  await page.getByRole('button', { name: /Expand/ }).click();
  // The side-by-side editor mounts inside the full-screen overlay.
  await page.locator('.fixed.inset-0 .view-lines').first().waitFor();
  // The file ends well above the fold; drop the empty editor below it.
  await capture(page, 'features/diffs-history.png', undefined, { clipHeight: 660 });
});

test('system prompts and modes', async ({ browser, page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await startDemo(page, {
    seed: { replies: [CHECKOUT_REPLY] },
    settings: {
      userSystemPrompts: DEMO_USER_PROMPTS,
      securitySystemPromptEnabled: true,
      testingSystemPromptEnabled: true,
    },
    overrides: { discover_skills: DEMO_SKILLS, discover_mcp_sources: DEMO_MCP },
  });
  const panel = page.locator('app-right-panel');
  const settle = async () => {
    await page.waitForTimeout(500);
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  };

  await panel.getByRole('button', { name: /System prom/ }).click();
  await panel.getByText('Stripe conventions').click();
  await settle();
  const prompts = await panel.screenshot({ animations: 'disabled' });

  await panel.getByRole('button', { name: 'Modes' }).click();
  await panel.getByRole('button', { name: 'Payments review' }).click();
  // Show the editor of the custom mode rather than the list of built-ins.
  await expect(panel.getByText('Activated prompts')).toBeVisible();
  await page.locator('app-modes-panel > div').evaluate((scroller) => {
    const card = [...scroller.querySelectorAll('.glass-inset')].at(-1) as HTMLElement;
    const offset = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += offset - 16;
  });
  await settle();
  const modes = await panel.screenshot({ animations: 'disabled' });

  await composeRow(browser, 'features/prompts-modes.png', [prompts, modes], 460);
});

test('providers and models', async ({ page }) => {
  await startDemo(page, {
    seed: { replies: [CHECKOUT_REPLY] },
    overrides: { ...REVIEW, list_endpoints: DEMO_ENDPOINTS },
  });
  await sendPrompt(page, CHECKOUT_PROMPT);
  await waitForTurn(page);
  await page
    .locator('app-composer')
    .getByRole('button', { name: /Claude Sonnet 5/ })
    .first()
    .click();
  await page.locator('#composer-model-menu').waitFor();
  await capture(page, 'features/providers-models.png', page.locator('app-chat-view'), {
    keepFocus: true,
  });
});

test('integrations', async ({ page }) => {
  await startDemo(page, {
    overrides: { discover_mcp_sources: DEMO_MCP },
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'MCP Server' }).first().click();
  await dialog.getByRole('tab', { name: /Configured/ }).click();
  await dialog
    .getByText('Detected configurations')
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await capture(page, 'features/integrations.png', dialog);
});

test('look and feel', async ({ browser }) => {
  const themes = [
    ['midnight', 'Midnight'],
    ['daylight', 'Daylight'],
    ['rose-pine', 'Rosé Pine'],
    ['catppuccin-latte', 'Catppuccin Latte'],
  ];
  const shots: { name: string; src: string }[] = [];
  for (const [theme, name] of themes) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      locale: 'en-US',
    });
    const themed = await context.newPage();
    await startDemo(themed, {
      seed: { replies: [CHECKOUT_REPLY] },
      settings: { theme },
      overrides: REVIEW,
    });
    await sendPrompt(themed, CHECKOUT_PROMPT);
    await waitForTurn(themed);
    await openDiff(themed);
    await themed.waitForTimeout(600);
    await themed.mouse.move(0, 0);
    await themed.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const png = await themed.screenshot({ animations: 'disabled' });
    shots.push({ name, src: `data:image/png;base64,${png.toString('base64')}` });
    await context.close();
  }

  // Tiles at half size on a 1.5x page: sharp enough to compare themes, at a
  // third of the file size of a 2x capture.
  const context = await browser.newContext({ deviceScaleFactor: 1.5 });
  const page = await context.newPage();
  await page.setContent(`
    <style>
      body { margin: 0; background: transparent; font: 600 13px system-ui, sans-serif; }
      #grid { display: grid; grid-template-columns: repeat(2, 720px); gap: 16px; width: max-content; }
      figure { margin: 0; position: relative; }
      img { display: block; width: 720px; height: 450px; border-radius: 12px; }
      figcaption {
        position: absolute; left: 12px; bottom: 12px; padding: 4px 10px; border-radius: 999px;
        background: rgba(0, 0, 0, 0.6); color: #fff; letter-spacing: 0.02em;
      }
    </style>
    <div id="grid">
      ${shots.map((shot) => `<figure><img src="${shot.src}"><figcaption>${shot.name}</figcaption></figure>`).join('')}
    </div>`);
  await page.locator('#grid').screenshot({
    path: 'docs/features/look-and-feel.png',
    omitBackground: true,
  });
  await context.close();
});
