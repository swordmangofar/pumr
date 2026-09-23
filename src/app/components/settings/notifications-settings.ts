import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { open } from '@tauri-apps/plugin-dialog';
import { isTauri } from '../../core/api';
import {
  SOUND_CUSTOM,
  SOUND_NONE,
  SOUND_PATH_KEYS,
  SOUND_PRESETS,
  SOUND_SELECTION_KEYS,
  SoundKind,
  SoundService,
} from '../../core/sound.service';
import { SettingsDraftService } from './settings-draft.service';

import { TypedInput } from '../typed-input';

@Component({
  selector: 'app-notifications-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe, NgTemplateOutlet],
  host: {
    '(document:click)': 'closeSoundDropdown()',
  },
  template: `
    <ng-template #speakerIcon>
      <svg
        viewBox="0 0 24 24"
        class="h-4 w-4"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M11 5 6 9H3v6h3l5 4V5Z" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
        <path d="M18.5 6a8 8 0 0 1 0 12" />
      </svg>
    </ng-template>

    <ng-template #checkIcon>
      <svg
        viewBox="0 0 12 12"
        class="mr-2 h-3.5 w-3.5 shrink-0 text-accent"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M2.5 6.5 5 9l4.5-5" />
      </svg>
    </ng-template>

    <section>
      <div class="flex items-center justify-between gap-4">
        <div>
          <h3 class="text-sm font-semibold text-white">
            {{ 'settings.sounds.title' | transloco }}
          </h3>
          <p class="mt-1 text-xs leading-relaxed text-mist/30">
            {{ 'settings.sounds.hint' | transloco }}
          </p>
        </div>
        <button
          type="button"
          class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
          [class]="draft.draft().soundsEnabled ? 'bg-accent' : 'bg-white/15'"
          (click)="draft.patch('soundsEnabled', !draft.draft().soundsEnabled)"
        >
          <span
            class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
            [class]="draft.draft().soundsEnabled ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
          ></span>
        </button>
      </div>

      @if (draft.draft().soundsEnabled) {
        <div class="mt-4 flex items-center gap-4 rounded-xl border border-white/10 p-4">
          <span class="text-sm text-mist">{{ 'settings.sounds.volume' | transloco }}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            class="flex-1 cursor-pointer accent-accent"
            [value]="draft.draft().soundVolume"
            (typedValue)="draft.patch('soundVolume', +$event)"
          />
          <span class="w-10 text-right text-xs tabular-nums text-mist/50">
            {{ (draft.draft().soundVolume * 100).toFixed(0) }}%
          </span>
        </div>

        @for (category of soundCategories; track category.kind) {
          <div class="mt-3 rounded-xl border border-white/10 p-4">
            <div>
              <h4 class="text-sm font-medium text-white">
                {{ category.labelKey | transloco }}
              </h4>
              <p class="mt-1 text-xs leading-relaxed text-mist/30">
                {{ category.hintKey | transloco }}
              </p>
            </div>

            <div class="relative mt-3">
              <div class="field flex items-center rounded-xl py-1.5 pr-2 pl-1.5">
                <button
                  type="button"
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors disabled:text-mist/20"
                  [class]="
                    canPreview(category.kind) ? 'text-accent hover:bg-accent/15' : 'text-mist/20'
                  "
                  [disabled]="!canPreview(category.kind)"
                  [title]="'settings.sounds.preview' | transloco"
                  (click)="previewCurrent(category.kind, $event)"
                >
                  <ng-container [ngTemplateOutlet]="speakerIcon" />
                </button>
                <button
                  type="button"
                  class="min-w-0 flex-1 truncate px-2 py-1 text-left text-sm text-mist"
                  (click)="toggleSoundDropdown(category.kind, $event)"
                >
                  {{ currentSoundLabel(category.kind) | transloco }}
                </button>
                <button
                  type="button"
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-mist/40 transition-colors hover:bg-white/5 hover:text-mist"
                  (click)="toggleSoundDropdown(category.kind, $event)"
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="h-3.5 w-3.5 transition-transform"
                    [class.rotate-180]="openSound() === category.kind"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </div>

              @if (openSound() === category.kind) {
                <div
                  class="absolute inset-x-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-ink/95 p-1 shadow-2xl backdrop-blur"
                  (click)="$event.stopPropagation()"
                >
                  @for (preset of soundPresets[category.kind]; track preset.id) {
                    <div
                      class="flex items-center gap-1 rounded-lg px-1 py-0.5 transition-colors"
                      [class]="
                        soundSelection(category.kind) === preset.id
                          ? 'bg-accent/15 text-white'
                          : 'text-mist/70 hover:bg-white/5'
                      "
                    >
                      <button
                        type="button"
                        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-accent transition-colors hover:bg-accent/15"
                        [title]="'settings.sounds.preview' | transloco"
                        (click)="previewPreset(preset.id, $event)"
                      >
                        <ng-container [ngTemplateOutlet]="speakerIcon" />
                      </button>
                      <button
                        type="button"
                        class="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
                        (click)="selectSound(category.kind, preset.id)"
                      >
                        {{ preset.labelKey | transloco }}
                      </button>
                      @if (soundSelection(category.kind) === preset.id) {
                        <ng-container [ngTemplateOutlet]="checkIcon" />
                      }
                    </div>
                  }

                  <div
                    class="flex items-center gap-1 rounded-lg px-1 py-0.5 transition-colors"
                    [class]="
                      soundSelection(category.kind) === soundNone
                        ? 'bg-accent/15 text-white'
                        : 'text-mist/70 hover:bg-white/5'
                    "
                  >
                    <span class="flex h-7 w-7 shrink-0 items-center justify-center text-mist/20">
                      <svg
                        viewBox="0 0 24 24"
                        class="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M11 5 6 9H3v6h3l5 4V5Z" />
                        <path d="m16 9 5 6M21 9l-5 6" />
                      </svg>
                    </span>
                    <button
                      type="button"
                      class="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
                      (click)="selectSound(category.kind, soundNone)"
                    >
                      {{ 'settings.sounds.none' | transloco }}
                    </button>
                    @if (soundSelection(category.kind) === soundNone) {
                      <ng-container [ngTemplateOutlet]="checkIcon" />
                    }
                  </div>

                  <div
                    class="flex items-center gap-1 rounded-lg px-1 py-0.5 transition-colors"
                    [class]="
                      soundSelection(category.kind) === soundCustom
                        ? 'bg-accent/15 text-white'
                        : 'text-mist/70 hover:bg-white/5'
                    "
                  >
                    <button
                      type="button"
                      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors disabled:text-mist/20"
                      [class]="
                        soundPath(category.kind) ? 'text-accent hover:bg-accent/15' : 'text-mist/20'
                      "
                      [disabled]="!soundPath(category.kind)"
                      [title]="'settings.sounds.preview' | transloco"
                      (click)="previewCustom(category.kind, $event)"
                    >
                      <ng-container [ngTemplateOutlet]="speakerIcon" />
                    </button>
                    <button
                      type="button"
                      class="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
                      (click)="selectSound(category.kind, soundCustom)"
                    >
                      {{ 'settings.sounds.custom' | transloco }}
                    </button>
                    @if (soundSelection(category.kind) === soundCustom) {
                      <ng-container [ngTemplateOutlet]="checkIcon" />
                    }
                  </div>
                </div>
              }
            </div>

            @if (soundSelection(category.kind) === soundCustom) {
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  class="field shrink-0 rounded-xl px-3 py-2 text-xs disabled:opacity-40"
                  [disabled]="!canPickFiles"
                  (click)="pickSoundFile(category.kind)"
                >
                  {{ 'settings.sounds.chooseFile' | transloco }}
                </button>
                @if (soundPath(category.kind)) {
                  <span class="flex min-w-0 items-center gap-2 text-xs text-mist/50">
                    <span class="max-w-52 truncate">{{ fileName(soundPath(category.kind)) }}</span>
                    <button
                      type="button"
                      class="text-mist/40 transition-colors hover:text-rose-300"
                      [title]="'settings.sounds.clearFile' | transloco"
                      (click)="draft.setSoundPath(category.kind, '')"
                    >
                      ✕
                    </button>
                  </span>
                } @else {
                  <span class="text-xs text-mist/30">
                    {{ 'settings.sounds.noFile' | transloco }}
                  </span>
                }
              </div>
            }
          </div>
        }

        <p class="mt-2 text-xs text-mist/30">{{ 'settings.sounds.builtinHint' | transloco }}</p>
      }
    </section>
  `,
})
export class NotificationsSettings {
  protected readonly draft = inject(SettingsDraftService);
  private readonly sound = inject(SoundService);
  protected readonly soundPresets = SOUND_PRESETS;
  protected readonly soundNone = SOUND_NONE;
  protected readonly soundCustom = SOUND_CUSTOM;
  protected readonly openSound = signal<SoundKind | null>(null);
  protected readonly canPickFiles = isTauri();
  protected readonly soundCategories: { kind: SoundKind; labelKey: string; hintKey: string }[] = [
    {
      kind: 'done',
      labelKey: 'settings.sounds.done',
      hintKey: 'settings.sounds.doneHint',
    },
    {
      kind: 'permission',
      labelKey: 'settings.sounds.permission',
      hintKey: 'settings.sounds.permissionHint',
    },
    {
      kind: 'error',
      labelKey: 'settings.sounds.error',
      hintKey: 'settings.sounds.errorHint',
    },
  ];

  protected soundSelection(kind: SoundKind): string {
    const settings = this.draft.draft();
    return String(settings[SOUND_SELECTION_KEYS[kind]] ?? SOUND_NONE);
  }

  protected soundPath(kind: SoundKind): string {
    return String(this.draft.draft()[SOUND_PATH_KEYS[kind]] ?? '');
  }

  protected canPreview(kind: SoundKind): boolean {
    const selection = this.soundSelection(kind);
    if (selection === SOUND_NONE) {
      return false;
    }
    return selection !== SOUND_CUSTOM || !!this.soundPath(kind);
  }

  protected currentSoundLabel(kind: SoundKind): string {
    const selection = this.soundSelection(kind);
    if (selection === SOUND_NONE) {
      return 'settings.sounds.none';
    }
    if (selection === SOUND_CUSTOM) {
      return 'settings.sounds.custom';
    }
    return (
      this.soundPresets[kind].find((preset) => preset.id === selection)?.labelKey ??
      'settings.sounds.none'
    );
  }

  protected toggleSoundDropdown(kind: SoundKind, event: Event): void {
    event.stopPropagation();
    this.openSound.update((open) => (open === kind ? null : kind));
  }

  protected closeSoundDropdown(): void {
    this.openSound.set(null);
  }

  protected selectSound(kind: SoundKind, value: string): void {
    this.draft.setSoundSelection(kind, value);
    this.openSound.set(null);
  }

  protected previewPreset(id: string, event: Event): void {
    event.stopPropagation();
    this.sound.preview(id, '', this.draft.draft().soundVolume);
  }

  protected previewCurrent(kind: SoundKind, event: Event): void {
    event.stopPropagation();
    if (this.canPreview(kind)) {
      this.previewSound(kind);
    }
  }

  protected previewCustom(kind: SoundKind, event: Event): void {
    event.stopPropagation();
    const path = this.soundPath(kind);
    if (path) {
      this.sound.preview(SOUND_CUSTOM, path, this.draft.draft().soundVolume);
    }
  }

  protected previewSound(kind: SoundKind): void {
    this.sound.preview(
      this.soundSelection(kind),
      this.soundPath(kind),
      this.draft.draft().soundVolume,
    );
  }

  protected async pickSoundFile(kind: SoundKind): Promise<void> {
    if (!this.canPickFiles) {
      return;
    }
    const selected = await open({
      multiple: false,
      directory: false,
      title: 'Select sound file',
      filters: [
        {
          name: 'Audio',
          extensions: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus', 'webm'],
        },
      ],
    });
    if (!selected || Array.isArray(selected)) {
      return;
    }
    this.draft.setSoundPath(kind, selected);
    this.draft.setSoundSelection(kind, SOUND_CUSTOM);
  }

  protected fileName(path: string): string {
    if (!path) {
      return '';
    }
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
  }
}
