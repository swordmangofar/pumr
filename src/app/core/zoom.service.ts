import { Injectable, signal } from '@angular/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { isTauri } from './api';
import { clampZoom, ZOOM_DEFAULT } from './zoom';

/**
 * Applies display scaling to the whole webview. The zoom level is persisted as
 * part of the window settings; this service only mirrors the current value so
 * the UI can preview changes and the hotkeys can step through levels.
 */
@Injectable({ providedIn: 'root' })
export class ZoomService {
  readonly level = signal(ZOOM_DEFAULT);

  apply(value: number): number {
    const zoom = clampZoom(value);
    this.level.set(zoom);
    if (isTauri()) {
      void getCurrentWebview()
        .setZoom(zoom)
        .catch(() => {
          // Ignore: unsupported platforms simply keep their default zoom.
        });
    }
    return zoom;
  }
}
