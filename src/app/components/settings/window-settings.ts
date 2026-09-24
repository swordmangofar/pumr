import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { api, isTauri } from '../../core/api';
import { displayHotkey, defaultWindowToggleHotkey, formatHotkey } from '../../core/hotkeys';
import { WindowToggleAction } from '../../core/models';
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../../core/zoom';
import { TypedInput } from '../typed-input';
import { SettingsDraftService } from './settings-draft.service';

@Component({
  selector: 'app-window-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe],
  template: `
    <section>
      <h3 class="text-sm font-semibold text-white">{{ 'settings.window.title' | transloco }}</h3>
      <p class="mt-1 text-xs leading-relaxed text-mist/30">
        {{ 'settings.window.hint' | transloco }}
      </p>

      <div class="window-demo mt-5" aria-hidden="true">
        <div class="window-demo-track">
          <div class="window-demo-monitor"></div>
          <div class="window-demo-monitor"></div>
          <div class="window-demo-window">
            <span class="window-demo-dot"></span>
            <span class="window-demo-dot"></span>
          </div>
        </div>
        <kbd class="window-demo-key">{{ hotkeyLabel() || '—' }}</kbd>
      </div>
    </section>

    <section class="mt-8 flex items-center justify-between gap-4">
      <div>
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.window.enable' | transloco }}
        </h3>
        <p class="mt-1 text-xs leading-relaxed text-mist/30">
          {{ 'settings.window.enableHint' | transloco }}
        </p>
      </div>
      <button
        type="button"
        class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        [class]="draft.draft().windowToggleEnabled ? 'bg-accent' : 'bg-white/15'"
        (click)="draft.patch('windowToggleEnabled', !draft.draft().windowToggleEnabled)"
      >
        <span
          class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
          [class]="draft.draft().windowToggleEnabled ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
        ></span>
      </button>
    </section>

    @if (draft.draft().windowToggleEnabled) {
      <section class="mt-8">
        <div
          class="flex items-center justify-between gap-4 rounded-xl border border-white/10 px-4 py-3"
        >
          <div class="min-w-0">
            <p class="text-sm font-medium text-white">
              {{ 'settings.window.hotkey' | transloco }}
            </p>
            <p class="mt-0.5 text-xs leading-relaxed text-mist/30">
              {{ 'settings.window.hotkeyHint' | transloco }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button
              type="button"
              class="field min-w-32 rounded-xl px-4 py-2 text-center font-mono text-sm transition-colors"
              [class]="
                recording()
                  ? 'border-accent/70 bg-accent/10 text-accent'
                  : 'text-mist hover:bg-white/5'
              "
              (click)="toggleRecording()"
            >
              @if (recording()) {
                {{ 'settings.hotkeys.recording' | transloco }}
              } @else {
                {{ hotkeyLabel() || '—' }}
              }
            </button>
            <button
              type="button"
              class="rounded-xl border border-white/10 px-3 py-2 text-xs text-mist/50 transition-colors hover:border-white/25 hover:text-mist disabled:opacity-30"
              [disabled]="draft.draft().windowToggleHotkey === defaultHotkey"
              [title]="'settings.hotkeys.reset' | transloco"
              (click)="reset()"
            >
              {{ 'settings.hotkeys.reset' | transloco }}
            </button>
          </div>
        </div>

        <div class="mt-3 rounded-xl border border-white/10 p-4">
          <p class="text-sm font-medium text-white">
            {{ 'settings.window.behaviour' | transloco }}
          </p>
          <p class="mt-0.5 text-xs leading-relaxed text-mist/30">
            {{ 'settings.window.behaviourHint' | transloco }}
          </p>
          <div class="mt-3 flex gap-2">
            @for (option of actions; track option.value) {
              <button
                type="button"
                class="rounded-xl border px-4 py-2 text-sm transition-colors"
                [class]="
                  draft.draft().windowToggleAction === option.value
                    ? 'border-accent/70 bg-accent/10 text-accent'
                    : 'border-white/10 text-mist/60 hover:bg-white/5 hover:text-mist'
                "
                (click)="draft.patch('windowToggleAction', option.value)"
              >
                {{ option.label | transloco }}
              </button>
            }
          </div>
        </div>

        <div class="mt-3 flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-white">
              {{ 'settings.window.fillScreen' | transloco }}
            </p>
            <p class="mt-0.5 text-xs leading-relaxed text-mist/30">
              {{ 'settings.window.fillScreenHint' | transloco }}
            </p>
          </div>
          <button
            type="button"
            class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
            [class]="draft.draft().windowToggleMaximize ? 'bg-accent' : 'bg-white/15'"
            (click)="draft.patch('windowToggleMaximize', !draft.draft().windowToggleMaximize)"
          >
            <span
              class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
              [class]="
                draft.draft().windowToggleMaximize ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'
              "
            ></span>
          </button>
        </div>
      </section>
    }

    <section class="mt-8">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h3 class="text-sm font-semibold text-white">
            {{ 'settings.window.zoom' | transloco }}
          </h3>
          <p class="mt-1 text-xs leading-relaxed text-mist/30">
            {{ 'settings.window.zoomHint' | transloco }}
          </p>
        </div>
        <span class="w-12 shrink-0 text-right text-sm tabular-nums text-mist/60">
          {{ (draft.draft().zoom * 100).toFixed(0) }}%
        </span>
      </div>
      <div class="mt-3 flex items-center gap-3">
        <input
          type="range"
          class="flex-1 cursor-pointer accent-accent"
          [min]="zoomMin"
          [max]="zoomMax"
          [step]="zoomStep"
          [value]="draft.draft().zoom"
          (typedValue)="draft.setZoom(+$event)"
        />
        <button
          type="button"
          class="rounded-xl border border-white/10 px-3 py-2 text-xs text-mist/50 transition-colors hover:border-white/25 hover:text-mist disabled:opacity-30"
          [disabled]="draft.draft().zoom === defaultZoom"
          (click)="draft.setZoom(defaultZoom)"
        >
          {{ 'settings.window.zoomReset' | transloco }}
        </button>
      </div>
    </section>
  `,
})
export class WindowSettings {
  protected readonly draft = inject(SettingsDraftService);
  protected readonly recording = signal(false);
  protected readonly defaultHotkey = defaultWindowToggleHotkey();
  protected readonly defaultZoom = ZOOM_DEFAULT;
  protected readonly zoomMin = ZOOM_MIN;
  protected readonly zoomMax = ZOOM_MAX;
  protected readonly zoomStep = ZOOM_STEP;
  protected readonly actions: { value: WindowToggleAction; label: string }[] = [
    { value: 'hide', label: 'settings.window.actionHide' },
    { value: 'minimize', label: 'settings.window.actionMinimize' },
  ];

  constructor() {
    const document = inject(DOCUMENT);
    const handler = (event: KeyboardEvent) => this.capture(event);
    document.addEventListener('keydown', handler, true);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('keydown', handler, true);
      this.stop();
    });
  }

  protected hotkeyLabel(): string {
    return displayHotkey(this.draft.draft().windowToggleHotkey);
  }

  protected toggleRecording(): void {
    if (this.recording()) {
      this.stop();
      return;
    }
    this.recording.set(true);
    this.draft.recording.set(true);
    void this.setSuspended(true);
  }

  protected capture(event: KeyboardEvent): void {
    if (!this.recording()) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      this.stop();
      return;
    }
    const hotkey = formatHotkey(event, true);
    if (!hotkey) {
      return;
    }
    this.draft.patch('windowToggleHotkey', hotkey);
    this.stop();
  }

  protected reset(): void {
    this.stop();
    this.draft.patch('windowToggleHotkey', this.defaultHotkey);
  }

  private stop(): void {
    if (!this.recording()) {
      return;
    }
    this.recording.set(false);
    this.draft.recording.set(false);
    void this.setSuspended(false);
  }

  private async setSuspended(suspended: boolean): Promise<void> {
    if (!isTauri()) {
      return;
    }
    try {
      await api.suspendWindowShortcut(suspended);
    } catch {
      // Ignore: the shortcut is re-applied whenever settings are saved.
    }
  }
}
