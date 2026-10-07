import { Injectable } from '@angular/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isTauri } from './api';
import {
  BACKGROUND_CUSTOM,
  BACKGROUND_NONE,
  BackgroundPreset,
  BackgroundStyle,
  findBackground,
} from './backgrounds';
import { Settings } from './models';

/** CSS custom properties consumed by `.app-background` and `.bg-preview`. */
const VAR_KEYS: Record<keyof BackgroundStyle, string> = {
  image: '--app-bg-image',
  color: '--app-bg-color',
  size: '--app-bg-size',
  position: '--app-bg-position',
  repeat: '--app-bg-repeat',
  mask: '--app-bg-mask',
  maskSize: '--app-bg-mask-size',
  maskPosition: '--app-bg-mask-position',
  maskRepeat: '--app-bg-mask-repeat',
  blend: '--app-bg-blend',
  opacity: '--app-bg-opacity',
};

const CUSTOM_IMAGE_OPACITY = 0.55;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

@Injectable({ providedIn: 'root' })
export class BackgroundService {
  /** Applies the configured backdrop to the whole document. */
  apply(settings: Settings | null): void {
    const root = document.documentElement;
    const style = this.resolve(settings);
    const opacity = this.opacity(style, settings);
    const blur = clamp(settings?.backgroundBlur ?? 0, 0, 60);

    // Write every variable on each pass (empty means "unset") so switching from
    // a mask preset back to a plain one never leaves a stale mask behind.
    const vars: Record<string, string> = {};
    for (const [key, cssVar] of Object.entries(VAR_KEYS)) {
      const value = style[key as keyof BackgroundStyle];
      vars[cssVar] = value === undefined || value === null ? '' : String(value);
    }
    vars['--app-bg-opacity'] = String(opacity);
    vars['--app-bg-filter'] = blur > 0 ? `blur(${blur}px)` : '';

    for (const [key, value] of Object.entries(vars)) {
      if (value) {
        root.style.setProperty(key, value);
      } else {
        root.style.removeProperty(key);
      }
    }
  }

  /** Style variables for a small in-dialog preview of a preset. */
  previewVars(preset: BackgroundPreset): Record<string, string> {
    return this.styleVars({ ...preset.style, ...preset.preview });
  }

  /**
   * Style variables for a miniature of the backdrop `settings` describe, with
   * the user's opacity and blur applied. `scale` is the size of the miniature
   * relative to the window, so the blur shrinks along with the picture.
   */
  miniatureVars(settings: Settings, scale: number): Record<string, string> {
    const style = {
      ...this.resolve(settings),
      ...findBackground(settings.background)?.preview,
    };
    const vars = this.styleVars(style);
    vars['--app-bg-opacity'] = String(this.opacity(style, settings));
    const blur = clamp(settings.backgroundBlur, 0, 60) * scale;
    if (blur > 0) {
      vars['--app-bg-filter'] = `blur(${blur}px)`;
    }
    return vars;
  }

  /** `url(...)` for the user's own image, or an empty string when unavailable. */
  customImageUrl(settings: Settings | null): string {
    const path = settings?.backgroundImage ?? '';
    if (!path || !isTauri()) {
      return '';
    }
    return `url("${convertFileSrc(path)}")`;
  }

  /** The preset's own opacity scaled by the user's setting. */
  private opacity(style: BackgroundStyle, settings: Settings | null): number {
    const userOpacity = clamp(settings?.backgroundOpacity ?? 1, 0, 1);
    return clamp((style.opacity ?? 1) * userOpacity, 0, 1);
  }

  private resolve(settings: Settings | null): BackgroundStyle {
    if (!settings) {
      return {};
    }
    const id = settings.background || BACKGROUND_NONE;
    if (id === BACKGROUND_NONE) {
      return {};
    }
    if (id === BACKGROUND_CUSTOM) {
      const image = this.customImageUrl(settings);
      if (!image) {
        return {};
      }
      return {
        image,
        size: 'cover',
        position: 'center',
        repeat: 'no-repeat',
        opacity: CUSTOM_IMAGE_OPACITY,
      };
    }
    return findBackground(id)?.style ?? {};
  }

  private styleVars(style: BackgroundStyle): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const [key, cssVar] of Object.entries(VAR_KEYS)) {
      const value = style[key as keyof BackgroundStyle];
      if (value !== undefined && value !== null && value !== '') {
        vars[cssVar] = String(value);
      }
    }
    return vars;
  }
}
