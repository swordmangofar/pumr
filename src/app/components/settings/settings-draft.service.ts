import { Injectable, inject, signal } from '@angular/core';
import { Settings } from '../../core/models';
import { FALLBACK_SETTINGS, SettingsService } from '../../core/settings.service';

@Injectable()
export class SettingsDraftService {
  private readonly settingsService = inject(SettingsService);

  readonly draft = signal<Settings>({
    ...FALLBACK_SETTINGS,
    ...(this.settingsService.settings() ?? {}),
  });
  readonly dirty = signal(false);
  readonly saving = signal(false);
  readonly saved = signal(false);

  patch<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.draft.update((draft) => ({ ...draft, [key]: value }));
    this.dirty.set(true);
    this.saved.set(false);
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
