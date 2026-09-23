import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { api, isTauri } from '../../core/api';
import {
  defaultCloseTabHotkey,
  defaultDeleteSessionHotkey,
  defaultNewSessionHotkey,
  defaultOpenTabHotkey,
  defaultWindowToggleHotkey,
  displayHotkey,
  formatHotkey,
} from '../../core/hotkeys';
import { SettingsDraftService } from './settings-draft.service';

type HotkeyField =
  | 'openTabHotkey'
  | 'closeTabHotkey'
  | 'newSessionHotkey'
  | 'deleteSessionHotkey'
  | 'windowToggleHotkey';

@Component({
  selector: 'app-hotkeys-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  host: {
    '(document:keydown)': 'capture($event)',
  },
  template: `
    <section>
      <h3 class="text-sm font-semibold text-white">{{ 'settings.hotkeys.title' | transloco }}</h3>
      <p class="mt-1 text-xs leading-relaxed text-mist/30">
        {{ 'settings.hotkeys.hint' | transloco }}
      </p>

      <div class="mt-5 space-y-3">
        @for (item of items; track item.field) {
          <div
            class="flex items-center justify-between gap-4 rounded-xl border border-white/10 px-4 py-3"
          >
            <div class="min-w-0">
              <p class="text-sm font-medium text-white">{{ item.label | transloco }}</p>
              <p class="mt-0.5 text-xs leading-relaxed text-mist/30">
                {{ item.hint | transloco }}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <button
                type="button"
                class="field min-w-32 rounded-xl px-4 py-2 text-center font-mono text-sm transition-colors"
                [class]="
                  active() === item.field
                    ? 'border-accent/70 bg-accent/10 text-accent'
                    : 'text-mist hover:bg-white/5'
                "
                (click)="toggle(item.field)"
              >
                @if (active() === item.field) {
                  {{ 'settings.hotkeys.recording' | transloco }}
                } @else {
                  {{ display(draft.draft()[item.field]) || '—' }}
                }
              </button>
              <button
                type="button"
                class="rounded-xl border border-white/10 px-3 py-2 text-xs text-mist/50 transition-colors hover:border-white/25 hover:text-mist disabled:opacity-30"
                [disabled]="draft.draft()[item.field] === item.default"
                [title]="'settings.hotkeys.reset' | transloco"
                (click)="reset(item.field, item.default)"
              >
                {{ 'settings.hotkeys.reset' | transloco }}
              </button>
            </div>
          </div>
        }
      </div>
    </section>
  `,
})
export class HotkeysSettings {
  protected readonly draft = inject(SettingsDraftService);
  protected readonly active = signal<HotkeyField | null>(null);
  protected readonly items: {
    field: HotkeyField;
    label: string;
    hint: string;
    default: string;
  }[] = [
    {
      field: 'openTabHotkey',
      label: 'settings.hotkeys.openTab',
      hint: 'settings.hotkeys.openTabHint',
      default: defaultOpenTabHotkey(),
    },
    {
      field: 'closeTabHotkey',
      label: 'settings.hotkeys.closeTab',
      hint: 'settings.hotkeys.closeTabHint',
      default: defaultCloseTabHotkey(),
    },
    {
      field: 'newSessionHotkey',
      label: 'settings.hotkeys.newSession',
      hint: 'settings.hotkeys.newSessionHint',
      default: defaultNewSessionHotkey(),
    },
    {
      field: 'deleteSessionHotkey',
      label: 'settings.hotkeys.deleteSession',
      hint: 'settings.hotkeys.deleteSessionHint',
      default: defaultDeleteSessionHotkey(),
    },
    {
      field: 'windowToggleHotkey',
      label: 'settings.hotkeys.windowToggle',
      hint: 'settings.hotkeys.windowToggleHint',
      default: defaultWindowToggleHotkey(),
    },
  ];

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  protected display(hotkey: string | null | undefined): string {
    return displayHotkey(hotkey);
  }

  protected toggle(field: HotkeyField): void {
    if (this.active() === field) {
      this.stop();
      return;
    }
    this.active.set(field);
    this.draft.recording.set(true);
    if (field === 'windowToggleHotkey') {
      void this.setSuspended(true);
    }
  }

  protected capture(event: KeyboardEvent): void {
    const field = this.active();
    if (!field) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      this.stop();
      return;
    }
    const hotkey = formatHotkey(
      event,
      field === 'deleteSessionHotkey'
        ? { anyKey: true }
        : field === 'windowToggleHotkey',
    );
    if (!hotkey) {
      return;
    }
    if (field === 'deleteSessionHotkey' && !this.isValidDeleteHotkey(hotkey)) {
      return;
    }
    this.draft.patch(field, hotkey);
    this.stop();
  }

  private isValidDeleteHotkey(hotkey: string): boolean {
    return hotkey.includes('+') || hotkey === 'Delete' || hotkey === 'Backspace';
  }

  protected reset(field: HotkeyField, value: string): void {
    this.stop();
    this.draft.patch(field, value);
  }

  private stop(): void {
    const field = this.active();
    this.active.set(null);
    this.draft.recording.set(false);
    if (field === 'windowToggleHotkey') {
      void this.setSuspended(false);
    }
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
