import { Injectable, signal } from '@angular/core';
import { api, isTauri } from './api';

/**
 * Knows whether the webview paints on the CPU, without GPU compositing, as
 * WebKitGTK does on X11. Every repaint then runs on the page's own thread, and
 * a display frame that changed in more than ten places is redrawn as
 * everything between them, so the interface trades some polish for small and
 * rare repaints: `styles.css` keys those rules off `data-renderer` on the root
 * element, and `BackdropCanvas` replaces the theme gradient.
 */
@Injectable({ providedIn: 'root' })
export class RenderingService {
  readonly software = signal(false);

  async init(): Promise<void> {
    if (!isTauri()) {
      return;
    }
    const software = await api.isSoftwareRendered().catch(() => false);
    if (software) {
      document.documentElement.dataset['renderer'] = 'software';
    }
    this.software.set(software);
  }
}
