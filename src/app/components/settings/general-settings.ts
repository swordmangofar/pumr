import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { CUSTOM_THEME_ID, THEME_PRESETS, ThemeColors } from '../../core/themes';
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
                {{
                  (theme.scheme === 'light' ? 'settings.themeLight' : 'settings.themeDark')
                    | transloco
                }}
              </span>
            </span>
          </button>
        }
        <button
          type="button"
          class="flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors"
          [class]="
            draft.draft().theme === customThemeId
              ? 'border-accent/70 bg-accent/10'
              : 'border-white/10 hover:border-white/25 hover:bg-white/5'
          "
          (click)="draft.selectTheme(customThemeId)"
        >
          <span
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
            [style.background-color]="draft.draft().customTheme.ink"
            [style.border-color]="draft.draft().customTheme.navy"
          >
            <span
              class="h-3 w-3 rounded-full"
              [style.background-color]="draft.draft().customTheme.accent"
            ></span>
          </span>
          <span class="min-w-0">
            <span class="block truncate text-sm font-medium text-white">
              {{ 'settings.themes.custom' | transloco }}
            </span>
            <span class="block text-xs text-mist/40">
              {{ 'settings.themeCustom' | transloco }}
            </span>
          </span>
        </button>
      </div>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.themeHint' | transloco }}</p>

      @if (draft.draft().theme === customThemeId) {
        <div class="mt-4 rounded-xl border border-white/10 p-4">
          <div class="mb-3 flex items-start justify-between gap-4">
            <div>
              <h3 class="text-sm font-semibold text-white">
                {{ 'settings.customTheme.title' | transloco }}
              </h3>
              <p class="mt-1 text-xs leading-relaxed text-mist/30">
                {{ 'settings.customTheme.hint' | transloco }}
              </p>
            </div>
            <button
              type="button"
              class="field shrink-0 rounded-xl px-3 py-1.5 text-xs"
              (click)="toggleCustomScheme()"
            >
              {{
                (draft.draft().customTheme.scheme === 'light'
                  ? 'settings.themeLight'
                  : 'settings.themeDark'
                ) | transloco
              }}
            </button>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            @for (field of customFields; track field.key) {
              <label
                class="flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2"
              >
                <span class="text-sm text-mist">{{ field.labelKey | transloco }}</span>
                <span class="flex items-center gap-2">
                  <input
                    type="color"
                    class="h-7 w-9 cursor-pointer rounded-md border border-white/15 bg-transparent p-0"
                    [value]="draft.draft().customTheme[field.key]"
                    (input)="setCustomColor(field.key, $any($event.target).value)"
                  />
                  <input
                    type="text"
                    class="field w-24 rounded-lg px-2 py-1 text-xs uppercase"
                    [value]="draft.draft().customTheme[field.key]"
                    (change)="setCustomColor(field.key, $any($event.target).value)"
                  />
                </span>
              </label>
            }
          </div>
        </div>
      }
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
        class="field field-select w-64 rounded-xl py-2 pr-9 pl-4 text-sm"
        [value]="draft.draft().language"
        (change)="draft.patch('language', $any($event.target).value)"
      >
        <option value="en">English</option>
        <option value="bg">Български</option>
        <option value="cs">Čeština</option>
        <option value="da">Dansk</option>
        <option value="de">Deutsch</option>
        <option value="el">Ελληνικά</option>
        <option value="es">Español</option>
        <option value="et">Eesti</option>
        <option value="fi">Suomi</option>
        <option value="fr">Français</option>
        <option value="ga">Gaeilge</option>
        <option value="hr">Hrvatski</option>
        <option value="hu">Magyar</option>
        <option value="it">Italiano</option>
        <option value="lt">Lietuvių</option>
        <option value="lv">Latviešu</option>
        <option value="mt">Malti</option>
        <option value="nl">Nederlands</option>
        <option value="pl">Polski</option>
        <option value="pt">Português</option>
        <option value="ro">Română</option>
        <option value="sk">Slovenčina</option>
        <option value="sl">Slovenščina</option>
        <option value="sv">Svenska</option>
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
  protected readonly customThemeId = CUSTOM_THEME_ID;
  protected readonly customFields: { key: keyof ThemeColors; labelKey: string }[] = [
    { key: 'ink', labelKey: 'settings.customTheme.ink' },
    { key: 'navy', labelKey: 'settings.customTheme.navy' },
    { key: 'accent', labelKey: 'settings.customTheme.accent' },
    { key: 'mist', labelKey: 'settings.customTheme.mist' },
    { key: 'white', labelKey: 'settings.customTheme.white' },
  ];

  protected setCustomColor(key: keyof ThemeColors, value: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(value.trim())) {
      return;
    }
    this.draft.setCustomTheme({ [key]: value.trim() });
  }

  protected toggleCustomScheme(): void {
    const scheme = this.draft.draft().customTheme.scheme === 'light' ? 'dark' : 'light';
    this.draft.setCustomTheme({ scheme });
  }
}
