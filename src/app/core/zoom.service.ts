import { Injectable, signal } from '@angular/core';
import { api, isTauri } from './api';
import { clampZoom, ZOOM_DEFAULT } from './zoom';

/**
 * Applies display scaling to the whole webview. The zoom level is persisted as
 * part of the window settings; this service only mirrors the current value so
 * the UI can preview changes and the hotkeys can step through levels. The
 * backend applies it, correcting for the desktop font DPI on Linux.
 */
@Injectable({ providedIn: 'root' })
export class ZoomService {
  readonly level = signal(ZOOM_DEFAULT);

  apply(value: number): number {
    const zoom = clampZoom(value);
    this.level.set(zoom);
    if (isTauri()) {
      void api.setInterfaceZoom(zoom).catch(() => {
        // Ignore: unsupported platforms simply keep their default zoom.
      });
    }
    return zoom;
  }
}
