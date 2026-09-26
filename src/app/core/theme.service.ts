import { Injectable, computed, signal } from '@angular/core';
import { isMacPlatform } from './hotkeys';
import {
  CUSTOM_THEME_ID,
  CustomTheme,
  DEFAULT_CUSTOM_THEME,
  DEFAULT_THEME_ID,
  THEME_PRESETS,
  ThemePreset,
  buildCustomPreset,
  findTheme,
} from './themes';

const STORAGE_KEY = 'pumr.theme';
const CONTRAST_KEY = 'pumr.highContrast';
const CUSTOM_KEY = 'pumr.customTheme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly presets = THEME_PRESETS;
  private readonly activeId = signal<string>(this.readCached(STORAGE_KEY, DEFAULT_THEME_ID));
  private readonly custom = signal<CustomTheme>(this.readCustom());
  readonly current = computed<ThemePreset>(() => this.resolve(this.activeId()));
  readonly customColors = this.custom.asReadonly();
  readonly highContrast = signal<boolean>(this.readCached(CONTRAST_KEY, 'false') === 'true');

  init(): void {
    // Lets styles.css keep macOS-only font smoothing off the other platforms.
    document.documentElement.dataset['platform'] = isMacPlatform() ? 'mac' : 'other';
    this.apply(this.activeId());
    this.applyContrast(this.highContrast());
    this.applyGlassOpacity(1);
  }

  resolve(id: string | null | undefined): ThemePreset {
    return id === CUSTOM_THEME_ID ? buildCustomPreset(this.custom()) : findTheme(id);
  }

  apply(id: string | null | undefined): void {
    const theme = this.resolve(id);
    this.activeId.set(theme.id);
    this.writeCached(STORAGE_KEY, theme.id);
    const root = document.documentElement;
    root.dataset['theme'] = theme.id;
    root.dataset['scheme'] = theme.scheme;
    root.style.colorScheme = theme.scheme;
    root.style.setProperty('--color-ink', theme.ink);
    root.style.setProperty('--color-navy', theme.navy);
    root.style.setProperty('--color-accent', theme.accent);
    root.style.setProperty('--color-mist', theme.mist);
    root.style.setProperty('--color-white', theme.white);
  }

  setCustom(custom: CustomTheme): void {
    this.custom.set(custom);
    this.writeCached(CUSTOM_KEY, JSON.stringify(custom));
    if (this.activeId() === CUSTOM_THEME_ID) {
      this.apply(CUSTOM_THEME_ID);
    }
  }

  applyContrast(enabled: boolean): void {
    this.highContrast.set(enabled);
    this.writeCached(CONTRAST_KEY, enabled ? 'true' : 'false');
    document.documentElement.dataset['contrast'] = enabled ? 'high' : 'normal';
  }

  /**
   * Scales the frosted-panel tint and blur. 1 keeps the default glass look,
   * lower values make the panels more transparent so the app background shows
   * through.
   */
  applyGlassOpacity(value: number): void {
    const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
    document.documentElement.style.setProperty('--glass-alpha', String(clamped));
  }

  private readCustom(): CustomTheme {
    try {
      const raw = localStorage.getItem(CUSTOM_KEY);
      if (raw) {
        return { ...DEFAULT_CUSTOM_THEME, ...(JSON.parse(raw) as Partial<CustomTheme>) };
      }
    } catch {
      // Fall through to the default custom palette.
    }
    return { ...DEFAULT_CUSTOM_THEME };
  }

  private readCached(key: string, fallback: string): string {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  private writeCached(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage is unavailable; the setting still applies for this session.
    }
  }
}
