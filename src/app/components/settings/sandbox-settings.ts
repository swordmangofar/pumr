import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { api } from '../../core/api';
import { SandboxMode, SandboxSupport } from '../../core/models';
import { SettingsDraftService } from './settings-draft.service';
import { TextList } from './text-list';

const MODES: readonly SandboxMode[] = ['off', 'files', 'filesAndNetwork'];

@Component({
  selector: 'app-sandbox-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, TextList],
  template: `
    <section>
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.sandbox.title' | transloco }}
      </h3>
      <p class="text-xs leading-relaxed text-mist/30">{{ 'settings.sandbox.hint' | transloco }}</p>
      @if (!support().files) {
        <p
          class="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-200"
          data-testid="sandbox-unavailable"
        >
          {{ 'settings.sandbox.unavailable' | transloco }}
        </p>
      }
      <div class="mt-4 space-y-2" role="radiogroup" [attr.aria-label]="'settings.sandbox.title' | transloco">
        @for (mode of modes; track mode) {
          <button
            type="button"
            role="radio"
            class="block w-full rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-40"
            [attr.data-testid]="'sandbox-mode-' + mode"
            [attr.aria-checked]="draft.draft().sandbox === mode"
            [disabled]="!available(mode)"
            [class]="
              draft.draft().sandbox === mode
                ? 'border-accent/70 bg-accent/10'
                : 'border-white/10 hover:bg-white/5'
            "
            (click)="draft.patch('sandbox', mode)"
          >
            <span
              class="block text-sm font-medium"
              [class]="draft.draft().sandbox === mode ? 'text-accent' : 'text-white'"
            >
              {{ 'settings.sandbox.modes.' + mode | transloco }}
            </span>
            <span class="mt-0.5 block text-xs leading-relaxed text-mist/40">
              {{ 'settings.sandbox.modeHints.' + mode | transloco }}
            </span>
          </button>
        }
      </div>
      @if (support().files && !support().network) {
        <p class="mt-2 text-xs leading-relaxed text-mist/30">
          {{ 'settings.sandbox.networkUnavailable' | transloco }}
        </p>
      }
    </section>

    <section class="mt-8">
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.sandbox.writable' | transloco }}
      </h3>
      <p class="mb-3 text-xs leading-relaxed text-mist/30">
        {{ 'settings.sandbox.writableHint' | transloco }}
      </p>
      <app-text-list
        data-testid="sandbox-writable"
        [items]="draft.draft().sandboxWritableFolders"
        (changed)="draft.patch('sandboxWritableFolders', $event)"
        addLabel="common.addFolder"
        emptyLabel="common.noFolders"
        placeholder="~/.cache"
      />
    </section>

    <section class="mt-8">
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.sandbox.unreadable' | transloco }}
      </h3>
      <p class="mb-3 text-xs leading-relaxed text-mist/30">
        {{ 'settings.sandbox.unreadableHint' | transloco }}
      </p>
      <app-text-list
        data-testid="sandbox-unreadable"
        [items]="draft.draft().sandboxUnreadableFolders"
        (changed)="draft.patch('sandboxUnreadableFolders', $event)"
        addLabel="common.addFolder"
        emptyLabel="common.noFolders"
        placeholder="~/.ssh"
      />
    </section>

    <section class="mt-8">
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.sandbox.excluded' | transloco }}
      </h3>
      <p class="mb-3 text-xs leading-relaxed text-mist/30">
        {{ 'settings.sandbox.excludedHint' | transloco }}
      </p>
      <app-text-list
        data-testid="sandbox-excluded"
        [items]="draft.draft().sandboxExcludedCommands"
        (changed)="draft.patch('sandboxExcludedCommands', $event)"
        addLabel="settings.sandbox.addCommand"
        emptyLabel="settings.sandbox.noCommands"
        placeholder="pnpm e2e"
      />
    </section>
  `,
})
export class SandboxSettings {
  protected readonly draft = inject(SettingsDraftService);

  protected readonly modes = MODES;
  /** Taken as able until the backend says otherwise, so nothing flickers. */
  protected readonly support = signal<SandboxSupport>({ files: true, network: true });

  constructor() {
    void api
      .getSandboxSupport()
      .then((support) => this.support.set(support))
      .catch(() => undefined);
  }

  /** Whether this machine can do what `mode` asks for. Off always is. */
  protected available(mode: SandboxMode): boolean {
    const support = this.support();
    return mode === 'off' || (mode === 'files' ? support.files : support.files && support.network);
  }
}
