import { Injectable, computed, signal } from '@angular/core';
import { DEFAULT_THEME_ID, THEME_PRESETS, ThemePreset, findTheme } from './themes';

const STORAGE_KEY = 'pumr.theme';
const CONTRAST_KEY = 'pumr.highContrast';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly presets = THEME_PRESETS;
  private readonly activeId = signal<string>(this.readCached(STORAGE_KEY, DEFAULT_THEME_ID));
  readonly current = computed<ThemePreset>(() => findTheme(this.activeId()));
  readonly highContrast = signal<boolean>(this.readCached(CONTRAST_KEY, 'false') === 'true');

  init(): void {
    this.apply(this.activeId());
    this.applyContrast(this.highContrast());
  }

  apply(id: string | null | undefined): void {
    const theme = findTheme(id);
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

  applyContrast(enabled: boolean): void {
    this.highContrast.set(enabled);
    this.writeCached(CONTRAST_KEY, enabled ? 'true' : 'false');
    document.documentElement.dataset['contrast'] = enabled ? 'high' : 'normal';
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