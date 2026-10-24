import type { Page } from '@playwright/test';
import { expect, project, seed, session, test } from './support/fixtures';
import type { FakeSeed } from './support/fake-backend';

/** The project folder: a little TypeScript and a little Rust. */
const FILES = {
  'src/app/composer.ts': 'export class Composer {\n  send(): void {\n  }\n}\n',
  'src/app/composer-editor.service.ts': 'export interface WordQuery {\n  term: string;\n}\n',
  'src-tauri/src/symbols.rs': 'pub struct WorkspaceSymbol {}\n\npub fn scan() {}\n',
  'README.md': '# demo\n',
};

async function openSession(page: Page, start: (seed: FakeSeed) => Promise<void>) {
  await page.addInitScript(() => {
    localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
    localStorage.setItem('pumr.activeTab', 'session-1');
  });
  await start(
    seed({ projects: [project()], sessions: [session({ title: 'New session' })], files: FILES }),
  );
  return page.getByRole('textbox', { name: /Describe your task/ });
}

test.describe('completion', () => {
  test('@ and the start of a name lists matching files; Tab takes the first', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start);
    const menu = page.getByRole('listbox');

    await composer.click();
    await page.keyboard.type('Look at @compo');
    await expect(menu.getByRole('option')).toHaveText([
      /^composer\.ts\s*src\/app\/composer\.ts/,
      /^composer-editor\.service\.ts/,
    ]);
    await expect(menu.getByRole('option', { selected: true })).toHaveText(/^composer\.ts/);

    await page.keyboard.press('Tab');
    await expect(menu).toHaveCount(0);
    await page.keyboard.type('please');
    await page.keyboard.press('Enter');

    const call = await app.backend.waitForCall('send_message');
    expect(call.args['content']).toBe('Look at please');
    expect(call.args['mentions']).toEqual([
      { kind: 'file', value: 'src/app/composer.ts', label: 'composer.ts' },
    ]);
  });

  test('the arrow keys move through the list and the right arrow takes a row', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start);
    const menu = page.getByRole('listbox');

    await composer.click();
    await page.keyboard.type('@compo');
    await expect(menu.getByRole('option')).toHaveCount(2);
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('option', { selected: true })).toHaveText(
      /^composer-editor\.service\.ts/,
    );
    await page.keyboard.press('ArrowRight');

    await expect(menu).toHaveCount(0);
    await expect(composer.locator('[data-mention]')).toHaveAttribute(
      'data-value',
      'src/app/composer-editor.service.ts',
    );
  });

  test('Ctrl+Space completes the word at the caret with a name or a path', async ({
    app,
    page,
  }) => {
    const composer = await openSession(page, app.start);
    const menu = page.getByRole('listbox');

    await composer.click();
    await page.keyboard.type('Rename WorkSy');
    await expect(menu).toHaveCount(0);
    await page.keyboard.press('Control+Space');
    await expect(menu.getByRole('option')).toHaveText([
      /^WorkspaceSymbol\s*src-tauri\/src\/symbols\.rs:1\s*struct$/,
    ]);
    await page.keyboard.press('Tab');
    await expect(composer).toHaveText('Rename WorkspaceSymbol ');

    // Typing on narrows the list, and a word typed to its end closes it.
    await page.keyboard.type('in sym');
    await page.keyboard.press('Control+Space');
    await expect(menu.getByRole('option').first()).toHaveText(/^symbols\.rs/);
    await page.keyboard.type('bols.r');
    await expect(menu.getByRole('option')).toHaveText([/^symbols\.rs/]);
    await page.keyboard.press('Enter');
    await expect(composer).toHaveText('Rename WorkspaceSymbol in src-tauri/src/symbols.rs ');

    await page.keyboard.type('and Comp');
    await page.keyboard.press('Control+Space');
    await expect(menu.getByRole('option').first()).toHaveText(/^Composer/);
    await page.keyboard.type(' ');
    await expect(menu).toHaveCount(0);

    await page.keyboard.press('Enter');
    const call = await app.backend.waitForCall('send_message');
    expect(call.args['content']).toBe(
      'Rename WorkspaceSymbol in src-tauri/src/symbols.rs and Comp',
    );
    expect(call.args['mentions']).toEqual([]);
  });

  test('Escape closes the completion and leaves the word as typed', async ({ app, page }) => {
    const composer = await openSession(page, app.start);
    const menu = page.getByRole('listbox');

    await composer.click();
    await page.keyboard.type('scan');
    await page.keyboard.press('Control+Space');
    await expect(menu.getByRole('option').first()).toHaveText(/^scan/);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveText('scan');
  });
});
