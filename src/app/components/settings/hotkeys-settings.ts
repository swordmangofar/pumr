import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { api, isTauri } from '../../core/api';
import {
  acceptsBareKey,
  ConfigurableHotkey,
  displayBindings,
  formatHotkey,
  HOTKEY_CATEGORIES,
  HOTKEY_DEFINITIONS,
  HotkeyDefinition,
  hotkeyBindings,
  splitHotkey,
} from '../../core/hotkeys';
import { SettingsDraftService } from './settings-draft.service';

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

      @for (group of groups; track group.category) {
        <h4 class="mt-6 text-xs font-semibold uppercase tracking-wider text-mist/40">
          {{ 'settings.hotkeys.category.' + group.category | transloco }}
        </h4>
        <div class="mt-2 space-y-2">
          @for (item of group.items; track item.id) {
            <div
              class="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/10 px-4 py-3"
            >
              <div class="min-w-0">
                <p class="text-sm font-medium text-white">{{ item.label | transloco }}</p>
                @if (item.hint) {
                  <p class="mt-0.5 text-xs leading-relaxed text-mist/30">
                    {{ item.hint | transloco }}
                  </p>
                }
              </div>
              <div class="flex shrink-0 items-center gap-2">
                @if (item.kind === 'fixed') {
                  <span
                    class="min-w-32 rounded-xl border border-white/5 px-4 py-2 text-center font-mono text-sm text-mist/50"
                  >
                    {{ display(item.keys) }}
                  </span>
                  <span
                    class="rounded-xl px-3 py-2 text-xs text-mist/30"
                    [title]="'settings.hotkeys.fixedHint' | transloco"
                  >
                    {{ 'settings.hotkeys.fixed' | transloco }}
                  </span>
                } @else {
                  <button
                    type="button"
                    class="field min-w-32 rounded-xl px-4 py-2 text-center font-mono text-sm transition-colors"
                    [class]="
                      active() === item.id
                        ? 'border-accent/70 bg-accent/10 text-accent'
                        : 'text-mist hover:bg-white/5'
                    "
                    (click)="toggle(item)"
                  >
                    @if (active() === item.id) {
                      {{ 'settings.hotkeys.recording' | transloco }}
                    } @else {
                      {{ display(bindings(item)) || '—' }}
                    }
                  </button>
                  <button
                    type="button"
                    class="rounded-xl border border-white/10 px-3 py-2 text-xs text-mist/50 transition-colors hover:border-white/25 hover:text-mist disabled:opacity-30"
                    [disabled]="isDefault(item)"
                    [title]="'settings.hotkeys.reset' | transloco"
                    (click)="reset(item)"
                  >
                    {{ 'settings.hotkeys.reset' | transloco }}
                  </button>
                }
              </div>
            </div>
          }
        </div>
      }
    </section>
  `,
})
export class HotkeysSettings {
  protected readonly draft = inject(SettingsDraftService);
  protected readonly active = signal<string | null>(null);
  protected readonly groups = HOTKEY_CATEGORIES.map((category) => ({
    category,
    items: HOTKEY_DEFINITIONS.filter((item) => item.category === category),
  })).filter((group) => group.items.length > 0);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  protected display(bindings: readonly string[]): string {
    return displayBindings(bindings);
  }

  protected bindings(item: ConfigurableHotkey): string[] {
    return hotkeyBindings(this.draft.draft(), item.id);
  }

  protected isDefault(item: ConfigurableHotkey): boolean {
    const settings = this.draft.draft();
    if (item.kind === 'field') {
      return settings[item.id] === item.defaults()[0];
    }
    return !settings.hotkeys?.[item.id];
  }

  protected toggle(item: ConfigurableHotkey): void {
    if (this.active() === item.id) {
      this.stop();
      return;
    }
    this.stop();
    this.active.set(item.id);
    this.draft.recording.set(true);
    if (item.id === 'windowToggleHotkey') {
      void this.setSuspended(true);
    }
  }

  protected capture(event: KeyboardEvent): void {
    const item = this.activeItem();
    if (!item) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      this.stop();
      return;
    }
    const hotkey = formatHotkey(event, { anyKey: !!item.bare });
    if (!hotkey) {
      return;
    }
    const parts = splitHotkey(hotkey);
    if (parts.length === 1 && !acceptsBareKey(item.bare, parts[0])) {
      return;
    }
    this.apply(item, hotkey);
    this.stop();
  }

  protected reset(item: ConfigurableHotkey): void {
    this.stop();
    this.apply(item, null);
  }

  /** Stores `hotkey`, or restores the default when it is `null`. */
  private apply(item: ConfigurableHotkey, hotkey: string | null): void {
    if (item.kind === 'field') {
      this.draft.patch(item.id, hotkey ?? item.defaults()[0]);
      return;
    }
    const rest = { ...this.draft.draft().hotkeys };
    delete rest[item.id];
    const isDefault =
      hotkey === null || (item.defaults().length === 1 && item.defaults()[0] === hotkey);
    this.draft.patch('hotkeys', isDefault ? rest : { ...rest, [item.id]: hotkey });
  }

  private activeItem(): ConfigurableHotkey | null {
    const id = this.active();
    const item = HOTKEY_DEFINITIONS.find((entry: HotkeyDefinition) => entry.id === id);
    return item && item.kind !== 'fixed' ? item : null;
  }

  private stop(): void {
    const id = this.active();
    this.active.set(null);
    this.draft.recording.set(false);
    if (id === 'windowToggleHotkey') {
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
