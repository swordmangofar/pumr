import { Injectable, inject, signal } from '@angular/core';
import { Settings } from '../../core/models';
import { BackgroundService } from '../../core/background.service';
import { BACKGROUND_CUSTOM, BACKGROUND_NONE } from '../../core/backgrounds';
import { FALLBACK_SETTINGS, SettingsService } from '../../core/settings.service';
import { SOUND_PATH_KEYS, SOUND_SELECTION_KEYS, SoundKind } from '../../core/sound.service';
import { ThemeService } from '../../core/theme.service';
import { CUSTOM_THEME_ID, CustomTheme } from '../../core/themes';
import { ZoomService } from '../../core/zoom.service';

@Injectable()
export class SettingsDraftService {
  private readonly settingsService = inject(SettingsService);
  private readonly theme = inject(ThemeService);
  private readonly background = inject(BackgroundService);
  private readonly zoom = inject(ZoomService);

  readonly draft = signal<Settings>({
    ...FALLBACK_SETTINGS,
    ...(this.settingsService.settings() ?? {}),
  });
  readonly dirty = signal(false);
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly recording = signal(false);

  patch<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.draft.update((draft) => ({ ...draft, [key]: value }));
    this.dirty.set(true);
    this.saved.set(false);
  }

  selectTheme(id: string): void {
    this.patch('theme', id);
    this.theme.apply(id);
  }

  setCustomTheme(patch: Partial<CustomTheme>): void {
    const customTheme = { ...this.draft().customTheme, ...patch };
    this.patch('customTheme', customTheme);
    this.theme.setCustom(customTheme);
    if (this.draft().theme !== CUSTOM_THEME_ID) {
      this.selectTheme(CUSTOM_THEME_ID);
    }
  }

  setHighContrast(enabled: boolean): void {
    this.patch('highContrast', enabled);
    this.theme.applyContrast(enabled);
  }

  setSoundSelection(kind: SoundKind, selection: string): void {
    this.patch(SOUND_SELECTION_KEYS[kind], selection);
  }

  setSoundPath(kind: SoundKind, path: string): void {
    this.patch(SOUND_PATH_KEYS[kind], path);
  }

  selectBackground(id: string): void {
    this.patch('background', id);
    this.background.apply(this.draft());
  }

  setBackgroundImage(path: string): void {
    this.patch('backgroundImage', path);
    this.patch('background', path ? BACKGROUND_CUSTOM : BACKGROUND_NONE);
    this.background.apply(this.draft());
  }

  setBackgroundOpacity(value: number): void {
    this.patch('backgroundOpacity', value);
    this.background.apply(this.draft());
  }

  setBackgroundBlur(value: number): void {
    this.patch('backgroundBlur', value);
    this.background.apply(this.draft());
  }

  setGlassOpacity(value: number): void {
    this.patch('glassOpacity', value);
    this.theme.applyGlassOpacity(value);
  }

  setZoom(value: number): void {
    const zoom = this.zoom.apply(value);
    this.patch('zoom', zoom);
  }

  async save(): Promise<void> {
    this.saving.set(true);
    try {
      await this.settingsService.save({
        ...this.draft(),
        commandRules: this.settingsService.settings()?.commandRules ?? [],
        deniedCommandRules: this.settingsService.settings()?.deniedCommandRules ?? [],
        allowedWebsites: this.settingsService.settings()?.allowedWebsites ?? [],
        deniedWebsites: this.settingsService.settings()?.deniedWebsites ?? [],
      });
      this.dirty.set(false);
      this.saved.set(true);
      setTimeout(() => this.saved.set(false), 2500);
    } finally {
      this.saving.set(false);
    }
  }
}
