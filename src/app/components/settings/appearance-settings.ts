import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { open } from '@tauri-apps/plugin-dialog';
import { isTauri } from '../../core/api';
import { BackgroundService } from '../../core/background.service';
import { BACKGROUND_CUSTOM, BACKGROUND_NONE, BACKGROUND_PRESETS } from '../../core/backgrounds';
import { CUSTOM_THEME_ID, THEME_PRESETS, ThemeColors } from '../../core/themes';
import { SettingsDraftService } from './settings-draft.service';

@Component({
  selector: 'app-appearance-settings',
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

    <section class="mt-8">
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.background.title' | transloco }}
      </label>
      <p class="mb-3 text-xs leading-relaxed text-mist/30">
        {{ 'settings.background.hint' | transloco }}
      </p>

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <button type="button" class="group text-left" (click)="draft.selectBackground(noneId)">
          <span
            class="bg-preview-frame block h-16 w-full rounded-lg border transition-colors"
            [class]="
              draft.draft().background === noneId
                ? 'border-accent/70 ring-1 ring-accent/40'
                : 'border-white/10 group-hover:border-white/25'
            "
          ></span>
          <span class="mt-1.5 block truncate text-xs text-mist/60">
            {{ 'settings.background.none' | transloco }}
          </span>
        </button>

        @for (preset of backgrounds; track preset.id) {
          <button type="button" class="group text-left" (click)="draft.selectBackground(preset.id)">
            <span
              class="bg-preview-frame block h-16 w-full rounded-lg border transition-colors"
              [class]="
                draft.draft().background === preset.id
                  ? 'border-accent/70 ring-1 ring-accent/40'
                  : 'border-white/10 group-hover:border-white/25'
              "
            >
              <span class="bg-preview" [style]="background.previewVars(preset)"></span>
            </span>
            <span class="mt-1.5 block truncate text-xs text-mist/60">
              {{ preset.labelKey | transloco }}
            </span>
          </button>
        }

        <button type="button" class="group text-left" (click)="pickBackgroundImage()">
          <span
            class="bg-preview-frame block h-16 w-full rounded-lg border transition-colors"
            [class]="
              draft.draft().background === customId
                ? 'border-accent/70 ring-1 ring-accent/40'
                : 'border-white/10 group-hover:border-white/25'
            "
          >
            @if (backgroundImageUrl()) {
              <span
                class="bg-preview"
                [style.--app-bg-image]="backgroundImageUrl()"
                [style.--app-bg-size]="'cover'"
                [style.--app-bg-repeat]="'no-repeat'"
                [style.--app-bg-opacity]="draft.draft().backgroundOpacity"
              ></span>
            } @else {
              <span class="absolute inset-0 flex items-center justify-center text-mist/30">
                <svg
                  viewBox="0 0 24 24"
                  class="h-6 w-6"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-4.35-4.35a2 2 0 0 0-2.83 0L4 21" />
                </svg>
              </span>
            }
          </span>
          <span class="mt-1.5 block truncate text-xs text-mist/60">
            {{ 'settings.background.custom' | transloco }}
          </span>
        </button>
      </div>

      @if (draft.draft().background !== noneId) {
        <div class="mt-4 space-y-3 rounded-xl border border-white/10 p-4">
          @if (draft.draft().background === customId) {
            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                class="field shrink-0 rounded-xl px-3 py-2 text-xs disabled:opacity-40"
                [disabled]="!canPickFiles"
                (click)="pickBackgroundImage()"
              >
                {{ 'settings.background.chooseFile' | transloco }}
              </button>
              @if (draft.draft().backgroundImage) {
                <span class="flex min-w-0 items-center gap-2 text-xs text-mist/50">
                  <span class="max-w-56 truncate">{{
                    fileName(draft.draft().backgroundImage)
                  }}</span>
                  <button
                    type="button"
                    class="text-mist/40 transition-colors hover:text-rose-300"
                    [title]="'settings.background.clearFile' | transloco"
                    (click)="draft.setBackgroundImage('')"
                  >
                    ✕
                  </button>
                </span>
              } @else {
                <span class="text-xs text-mist/30">
                  {{ 'settings.background.noFile' | transloco }}
                </span>
              }
            </div>
          }

          <div class="flex items-center gap-3">
            <span class="w-16 shrink-0 text-sm text-mist">
              {{ 'settings.background.opacity' | transloco }}
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              class="flex-1 cursor-pointer accent-accent"
              [value]="draft.draft().backgroundOpacity"
              (input)="draft.setBackgroundOpacity(+$any($event.target).value)"
            />
            <span class="w-10 text-right text-xs tabular-nums text-mist/50">
              {{ (draft.draft().backgroundOpacity * 100).toFixed(0) }}%
            </span>
          </div>

          <div class="flex items-center gap-3">
            <span class="w-16 shrink-0 text-sm text-mist">
              {{ 'settings.background.blur' | transloco }}
            </span>
            <input
              type="range"
              min="0"
              max="40"
              step="1"
              class="flex-1 cursor-pointer accent-accent"
              [value]="draft.draft().backgroundBlur"
              (input)="draft.setBackgroundBlur(+$any($event.target).value)"
            />
            <span class="w-10 text-right text-xs tabular-nums text-mist/50">
              {{ draft.draft().backgroundBlur }}px
            </span>
          </div>
        </div>
      }
    </section>

    <section class="mt-8">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h3 class="text-sm font-semibold text-white">
            {{ 'settings.glassOpacity' | transloco }}
          </h3>
          <p class="mt-1 text-xs leading-relaxed text-mist/30">
            {{ 'settings.glassOpacityHint' | transloco }}
          </p>
        </div>
        <span class="w-10 shrink-0 text-right text-xs tabular-nums text-mist/50">
          {{ (draft.draft().glassOpacity * 100).toFixed(0) }}%
        </span>
      </div>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        class="mt-3 w-full cursor-pointer accent-accent"
        [value]="draft.draft().glassOpacity"
        (input)="draft.setGlassOpacity(+$any($event.target).value)"
      />
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
  `,
})
export class AppearanceSettings {
  protected readonly draft = inject(SettingsDraftService);
  protected readonly background = inject(BackgroundService);
  protected readonly themes = THEME_PRESETS;
  protected readonly customThemeId = CUSTOM_THEME_ID;
  protected readonly backgrounds = BACKGROUND_PRESETS;
  protected readonly noneId = BACKGROUND_NONE;
  protected readonly customId = BACKGROUND_CUSTOM;
  protected readonly canPickFiles = isTauri();
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

  protected fileName(path: string): string {
    if (!path) {
      return '';
    }
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
  }

  protected backgroundImageUrl(): string {
    return this.background.customImageUrl(this.draft.draft());
  }

  protected async pickBackgroundImage(): Promise<void> {
    if (!this.canPickFiles) {
      return;
    }
    const selected = await open({
      multiple: false,
      directory: false,
      title: 'Select background image',
      filters: [
        {
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'],
        },
      ],
    });
    if (!selected || Array.isArray(selected)) {
      return;
    }
    this.draft.setBackgroundImage(selected);
  }
}
