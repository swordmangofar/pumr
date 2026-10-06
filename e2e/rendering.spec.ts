import { expect, project, seed, session, test } from './support/fixtures';

/**
 * What the app changes where the webview paints on the CPU, without GPU
 * compositing (WebKitGTK on X11). Chromium composites on the GPU either way;
 * these tests pin down the measures, the Linux harness measures their effect.
 */
test.describe('software rendering', () => {
  test('keeps the theme gradient where the GPU composites', async ({ app, page }) => {
    await app.start();

    await expect(page.locator('html')).not.toHaveAttribute('data-renderer');
    await expect(page.locator('canvas.app-backdrop')).toHaveCount(0);
    const gradient = await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundImage,
    );
    expect(gradient).toContain('radial-gradient');
  });

  test('paints the theme gradient once, as a bitmap', async ({ app, page }) => {
    await app.start(seed({ softwareRendering: true }));

    await expect(page.locator('html')).toHaveAttribute('data-renderer', 'software');
    const backdrop = page.locator('canvas.app-backdrop');
    await expect(backdrop).toBeAttached();
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).backgroundImage),
    ).toBe('none');

    // The bitmap has the window's shape and carries the theme's glows: the top
    // left corner is lit by the navy one, so it is not the plain ink colour.
    const { ratio, window, corner, ink } = await backdrop.evaluate((canvas: HTMLCanvasElement) => {
      const pixel = canvas.getContext('2d')?.getImageData(0, 0, 1, 1).data ?? [];
      return {
        ratio: canvas.width / canvas.height,
        window: innerWidth / innerHeight,
        corner: Array.from(pixel).slice(0, 3),
        ink: getComputedStyle(document.documentElement).getPropertyValue('--color-ink').trim(),
      };
    });
    expect(ratio).toBeCloseTo(window, 1);
    expect(ink).toBe('#000000');
    expect(corner.some((channel) => channel > 8)).toBe(true);
  });

  test('moves every endless animation in steps while a turn runs', async ({ app, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('pumr.tabs', JSON.stringify(['session-1']));
      localStorage.setItem('pumr.activeTab', 'session-1');
    });
    await app.start(
      seed({
        softwareRendering: true,
        projects: [project()],
        sessions: [session({ title: 'New session' })],
        replies: [{ steps: [{ kind: 'text', text: 'Starting a long job' }, { kind: 'hang' }] }],
      }),
    );

    await page.getByRole('textbox', { name: /Describe your task/ }).click();
    await page.keyboard.type('Run the long job');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toContainText('Starting a long job');
    // The tab and the sidebar row both show the turn running.
    await expect(page.locator('app-puma-spinner')).toHaveCount(2);

    // An animation that changes on every display frame is part of every repaint,
    // and past ten changed places WebKitGTK redraws everything between them.
    const animations = await page.evaluate(() =>
      document.getAnimations().flatMap((animation) => {
        const effect = animation.effect as KeyframeEffect | null;
        if (!effect || effect.getTiming().iterations !== Infinity) {
          return [];
        }
        const frames = effect.getKeyframes();
        return [
          {
            name: (animation as CSSAnimation).animationName,
            stepped: frames.slice(0, -1).every((frame) => frame.easing.startsWith('steps')),
          },
        ];
      }),
    );
    expect(animations.length).toBeGreaterThan(0);
    expect(animations.filter((animation) => !animation.stepped)).toEqual([]);
    // The streaming caret is among them: it blinks instead of fading.
    expect(animations.map((animation) => animation.name)).toContain('pulse');

    // A spinner changes as one area: whole frames, no cell animates by itself.
    const spinner = page.locator('app-puma-spinner').first();
    await expect(spinner.locator('g.puma-frame')).toHaveCount(8);
    expect(
      await spinner.evaluate((host) => host.getAnimations({ subtree: true }).length),
    ).toBe(8);

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });
});
