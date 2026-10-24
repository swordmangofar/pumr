import { Injectable, signal } from '@angular/core';
import { api, isTauri } from './api';

/**
 * Knows whether the webview paints on the CPU, without GPU compositing, as
 * WebKitGTK does on X11. Every repaint then runs on the page's own thread, and
 * a display frame that changed in more than ten places is redrawn as
 * everything between them, so the interface trades some polish for small and
 * rare repaints: `styles.css` keys those rules off `data-renderer` on the root
 * element, and `BackdropCanvas` replaces the theme gradient.
 *
 * It also knows whether the compositor blurs what lies in front of a
 * `backdrop-filter` into its backdrop, as WebKitGTK before 2.54 does. The
 * panels' blur would then make their own text glow, so `styles.css` leaves it
 * out where the root element has `data-backdrop="leaky"`.
 */
@Injectable({ providedIn: 'root' })
export class RenderingService {
  readonly software = signal(false);

  async init(): Promise<void> {
    if (!isTauri()) {
      return;
    }
    const [software, leakyBackdrop] = await Promise.all([
      api.isSoftwareRendered().catch(() => false),
      api.hasLeakyBackdrop().catch(() => false),
    ]);
    const root = document.documentElement;
    if (software) {
      root.dataset['renderer'] = 'software';
    }
    if (leakyBackdrop) {
      root.dataset['backdrop'] = 'leaky';
    }
    this.software.set(software);
  }
}
