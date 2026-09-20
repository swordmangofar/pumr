import { Injectable, inject, signal } from '@angular/core';
import { Settings } from '../../core/models';
import { FALLBACK_SETTINGS, SettingsService } from '../../core/settings.service';
import { ThemeService } from '../../core/theme.service';
import { CUSTOM_THEME_ID, CustomTheme } from '../../core/themes';

@Injectable()
export class SettingsDraftService {
  private readonly settingsService = inject(SettingsService);
  private readonly theme = inject(ThemeService);

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

  async save(): Promise<void> {
    this.saving.set(true);
    try {
      await this.settingsService.save({
        ...this.draft(),
        commandRules: this.settingsService.settings()?.commandRules ?? [],
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
