import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { THEME_PRESETS } from '../../core/themes';
import { SettingsDraftService } from './settings-draft.service';

@Component({
  selector: 'app-general-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <section>
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.theme' | transloco }}
      </label>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        @for (theme of themes; track theme.id) {
          <button
            type="button"
            class="flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors"
            [class]="
              draft.draft().theme === theme.id
                ? 'border-accent/70 bg-accent/10'
                : 'border-white/10 hover:border-white/25 hover:bg-white/5'
            "
            (click)="draft.selectTheme(theme.id)"
          >
            <span
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
              [style.background-color]="theme.ink"
              [style.border-color]="theme.navy"
            >
              <span class="h-3 w-3 rounded-full" [style.background-color]="theme.accent"></span>
            </span>
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium text-white">
                {{ theme.labelKey | transloco }}
              </span>
              <span class="block text-xs text-mist/40">
                {{ (theme.scheme === 'light' ? 'settings.themeLight' : 'settings.themeDark') | transloco }}
              </span>
            </span>
          </button>
        }
      </div>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.themeHint' | transloco }}</p>
    </section>

    <section class="mt-8 flex items-center justify-between gap-4">
      <div>
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.highContrast' | transloco }}
        </h3>
        <p class="mt-1 text-xs leading-relaxed text-mist/30">
          {{ 'settings.highContrastHint' | transloco }}
        </p>
      </div>
      <button
        type="button"
        class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        [class]="draft.draft().highContrast ? 'bg-accent' : 'bg-white/15'"
        (click)="draft.setHighContrast(!draft.draft().highContrast)"
      >
        <span
          class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
          [class]="draft.draft().highContrast ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
        ></span>
      </button>
    </section>

    <section class="mt-8">
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.language' | transloco }}
      </label>
      <select
        class="w-64 rounded-xl border border-white/10 bg-ink/60 px-4 py-2 text-sm text-mist outline-none focus:border-accent/60"
        [value]="draft.draft().language"
        (change)="draft.patch('language', $any($event.target).value)"
      >
        <option value="en">English</option>
        <option value="de">Deutsch</option>
      </select>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.languageHint' | transloco }}</p>
    </section>

    <section class="mt-8 flex items-center justify-between gap-4">
      <div>
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.keepAwake' | transloco }}
        </h3>
        <p class="mt-1 text-xs leading-relaxed text-mist/30">
          {{ 'settings.keepAwakeHint' | transloco }}
        </p>
      </div>
      <button
        type="button"
        class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        [class]="draft.draft().keepAwake ? 'bg-accent' : 'bg-white/15'"
        (click)="draft.patch('keepAwake', !draft.draft().keepAwake)"
      >
        <span
          class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
          [class]="draft.draft().keepAwake ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
        ></span>
      </button>
    </section>

    <section class="mt-8 flex items-center justify-between gap-4">
      <div>
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.tabsMultiline' | transloco }}
        </h3>
        <p class="mt-1 text-xs leading-relaxed text-mist/30">
          {{ 'settings.tabsMultilineHint' | transloco }}
        </p>
      </div>
      <button
        type="button"
        class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        [class]="draft.draft().tabsMultiline ? 'bg-accent' : 'bg-white/15'"
        (click)="draft.patch('tabsMultiline', !draft.draft().tabsMultiline)"
      >
        <span
          class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
          [class]="draft.draft().tabsMultiline ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
        ></span>
      </button>
    </section>

    <section class="mt-8">
      <h3 class="mb-3 text-sm font-semibold text-white">
        {{ 'settings.general.about' | transloco }}
      </h3>
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between gap-3">
          <dt class="text-mist/40">{{ 'settings.general.version' | transloco }}</dt>
          <dd class="text-mist">0.1.0</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-mist/40">{{ 'settings.general.model' | transloco }}</dt>
          <dd class="text-mist">pumr · Angular + Tauri</dd>
        </div>
      </dl>
      <p class="mt-4 text-xs leading-relaxed text-mist/30">
        {{ 'settings.general.storage' | transloco }}
      </p>
    </section>
  `,
})
export class GeneralSettings {
  protected readonly draft = inject(SettingsDraftService);
  protected readonly themes = THEME_PRESETS;
}
