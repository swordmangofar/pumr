import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { api, isTauri } from '../../core/api';
import { BackgroundService } from '../../core/background.service';
import { BACKGROUND_CUSTOM, BACKGROUND_NONE, BACKGROUND_PRESETS } from '../../core/backgrounds';
import { LOGOS } from '../../core/logos';
import { CUSTOM_THEME_ID, THEME_PRESETS, ThemeColors } from '../../core/themes';
import { SettingsDraftService } from './settings-draft.service';

import { TypedInput } from '../typed-input';

/** Width of the preview next to the sliders relative to a typical window. */
const PREVIEW_SCALE = 0.25;

@Component({
  selector: 'app-appearance-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe],
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
                    (typedValue)="setCustomColor(field.key, $event)"
                  />
                  <input
                    type="text"
                    class="field w-24 rounded-lg px-2 py-1 text-xs uppercase"
                    [value]="draft.draft().customTheme[field.key]"
                    (typedValue)="setCustomColor(field.key, $event)"
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
        {{ 'settings.logo.title' | transloco }}
      </label>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        @for (logo of logos; track logo.id) {
          <button
            type="button"
            class="flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors"
            [class]="
              draft.draft().logo === logo.id
                ? 'border-accent/70 bg-accent/10'
                : 'border-white/10 hover:border-white/25 hover:bg-white/5'
            "
            (click)="draft.selectLogo(logo.id)"
          >
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-navy">
              <img [src]="logo.src" alt="" class="h-6 w-6" />
            </span>
            <span class="block min-w-0 truncate text-sm font-medium text-white">
              {{ logo.labelKey | transloco }}
            </span>
          </button>
        }
      </div>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.logo.hint' | transloco }}</p>
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

      @if (draft.draft().background === customId) {
        <div class="mt-4 flex flex-wrap items-center gap-2">
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
              <span class="max-w-56 truncate">{{ fileName(draft.draft().backgroundImage) }}</span>
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

      <div class="mt-4 flex flex-col gap-5 rounded-xl border border-white/10 p-4 lg:flex-row">
        <div class="shrink-0 lg:w-80">
          <span class="mb-2 block text-xs text-mist/40">
            {{ 'settings.background.preview' | transloco }}
          </span>
          <div
            class="appearance-preview bg-preview-frame flex aspect-[16/10] w-full gap-1.5 rounded-xl border border-white/10 p-2"
            data-testid="appearance-preview"
            aria-hidden="true"
            [style.--glass-alpha]="draft.draft().glassOpacity"
          >
            <span class="bg-preview" [style]="previewVars()"></span>
            <div class="glass flex w-[30%] flex-col gap-2 rounded-lg p-2.5">
              <span class="h-1.5 w-3/4 rounded-full bg-white/70"></span>
              <span class="h-1.5 w-full rounded-full bg-accent/80"></span>
              <span class="h-1.5 w-2/3 rounded-full bg-mist/40"></span>
              <span class="h-1.5 w-5/6 rounded-full bg-mist/40"></span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
              <div class="glass flex flex-1 flex-col gap-2 rounded-lg p-2.5">
                <div class="glass-inset ml-auto flex w-1/2 flex-col gap-1.5 rounded-md p-2">
                  <span class="h-1.5 w-full rounded-full bg-white/70"></span>
                  <span class="h-1.5 w-2/3 rounded-full bg-white/70"></span>
                </div>
                <span class="h-1.5 w-5/6 rounded-full bg-mist/50"></span>
                <span class="h-1.5 w-3/4 rounded-full bg-mist/50"></span>
                <span class="h-1.5 w-1/2 rounded-full bg-mist/50"></span>
              </div>
              <div class="glass flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5">
                <span class="h-1.5 flex-1 rounded-full bg-mist/30"></span>
                <span class="h-4 w-4 rounded-full bg-accent"></span>
              </div>
            </div>
          </div>
        </div>

        <div class="min-w-0 flex-1 space-y-4">
          @if (draft.draft().background !== noneId) {
            <div>
              <span class="flex items-baseline justify-between gap-3">
                <span class="text-sm text-mist">
                  {{ 'settings.background.opacity' | transloco }}
                </span>
                <span class="shrink-0 text-xs tabular-nums text-mist/50">
                  {{ (draft.draft().backgroundOpacity * 100).toFixed(0) }}%
                </span>
              </span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                class="mt-2 w-full cursor-pointer accent-accent"
                [attr.aria-label]="'settings.background.opacity' | transloco"
                [value]="draft.draft().backgroundOpacity"
                (typedValue)="draft.setBackgroundOpacity(+$event)"
                (change)="draft.applyBackdrop()"
              />
            </div>

            <div>
              <span class="flex items-baseline justify-between gap-3">
                <span class="text-sm text-mist">
                  {{ 'settings.background.blur' | transloco }}
                </span>
                <span class="shrink-0 text-xs tabular-nums text-mist/50">
                  {{ draft.draft().backgroundBlur }}px
                </span>
              </span>
              <input
                type="range"
                min="0"
                max="40"
                step="1"
                class="mt-2 w-full cursor-pointer accent-accent"
                [attr.aria-label]="'settings.background.blur' | transloco"
                [value]="draft.draft().backgroundBlur"
                (typedValue)="draft.setBackgroundBlur(+$event)"
                (change)="draft.applyBackdrop()"
              />
            </div>
          }

          <div [class]="draft.draft().background !== noneId ? 'border-t border-white/10 pt-4' : ''">
            <span class="flex items-baseline justify-between gap-3">
              <span class="text-sm text-mist">{{ 'settings.glassOpacity' | transloco }}</span>
              <span class="shrink-0 text-xs tabular-nums text-mist/50">
                {{ (draft.draft().glassOpacity * 100).toFixed(0) }}%
              </span>
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              class="mt-2 w-full cursor-pointer accent-accent"
              [attr.aria-label]="'settings.glassOpacity' | transloco"
              [value]="draft.draft().glassOpacity"
              (typedValue)="draft.setGlassOpacity(+$event)"
              (change)="draft.applyBackdrop()"
            />
            <p class="mt-2 text-xs leading-relaxed text-mist/30">
              {{ 'settings.glassOpacityHint' | transloco }}
            </p>
          </div>
        </div>
      </div>
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
  protected readonly logos = LOGOS;
  protected readonly backgrounds = BACKGROUND_PRESETS;
  protected readonly noneId = BACKGROUND_NONE;
  protected readonly customId = BACKGROUND_CUSTOM;
  protected readonly canPickFiles = isTauri();
  protected readonly previewVars = computed(() =>
    this.background.miniatureVars(this.draft.draft(), PREVIEW_SCALE),
  );
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
    const selected = await api.pickAssetFile('image');
    if (!selected) {
      return;
    }
    this.draft.setBackgroundImage(selected);
  }
}
