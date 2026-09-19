import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Settings, UserSystemPrompt } from '../core/models';
import { SettingsService } from '../core/settings.service';

type BuiltinKey = 'securitySystemPrompt' | 'testingSystemPrompt' | 'architectureSystemPrompt';

type BuiltinEnabledKey =
  'securitySystemPromptEnabled' | 'testingSystemPromptEnabled' | 'architectureSystemPromptEnabled';

interface BuiltinPrompt {
  key: BuiltinKey;
  enabledKey: BuiltinEnabledKey;
  labelKey: string;
  descriptionKey: string;
}

@Component({
  selector: 'app-system-prompts-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <div class="min-h-0 flex-1 overflow-y-auto">
      <section class="border-b border-white/10 p-4">
        <h3 class="mb-1 text-xs font-semibold uppercase tracking-widest text-mist/40">
          {{ 'right.activePrompts' | transloco }}
        </h3>
        <p class="mb-3 text-xs leading-relaxed text-mist/30">
          {{ 'right.activePromptsHint' | transloco }}
        </p>

        <div class="mb-1.5 rounded-xl border border-white/10 bg-navy/30 px-3 py-2">
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-mist">{{ 'right.basePrompt' | transloco }}</span>
            <span
              class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent"
            >
              {{ 'right.alwaysOn' | transloco }}
            </span>
          </div>
        </div>

        @for (prompt of builtinPrompts; track prompt.key) {
          <div class="mb-1.5 rounded-xl border border-white/10 bg-navy/30">
            <div class="flex items-center gap-2.5 px-3 py-2">
              <button
                type="button"
                role="switch"
                [attr.aria-checked]="builtinEnabled(prompt)"
                class="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                [class]="builtinEnabled(prompt) ? 'bg-accent' : 'bg-white/15'"
                (click)="toggleBuiltin(prompt)"
              >
                <span
                  class="absolute top-0.5 h-4 w-4 rounded-full transition-all"
                  [class]="builtinEnabled(prompt) ? 'left-4.5 bg-ink' : 'left-0.5 bg-white'"
                ></span>
              </button>
              <button
                type="button"
                class="min-w-0 flex-1 truncate text-left text-sm"
                [class]="builtinEnabled(prompt) ? 'text-mist' : 'text-mist/40'"
                (click)="toggleExpanded(prompt.key)"
              >
                {{ prompt.labelKey | transloco }}
              </button>
              <span class="shrink-0 text-mist/30">{{ expanded(prompt.key) ? '▾' : '▸' }}</span>
            </div>
            @if (expanded(prompt.key)) {
              <pre
                class="max-h-60 overflow-auto border-t border-white/10 px-3 py-2 text-xs whitespace-pre-wrap text-mist/50"
                >{{ builtinText(prompt) }}</pre>
            }
          </div>
        }

        <button
          type="button"
          class="mt-2 text-xs text-accent transition-colors hover:text-accent/80"
          (click)="editInSettings()"
        >
          {{ 'right.editInSettings' | transloco }}
        </button>
      </section>

      <section class="p-4">
        <div class="mb-1 flex items-center justify-between gap-2">
          <h3 class="text-xs font-semibold uppercase tracking-widest text-mist/40">
            {{ 'right.yourPrompts' | transloco }}
          </h3>
          <button
            type="button"
            class="rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:border-accent/50 hover:text-white"
            (click)="addPrompt()"
          >
            + {{ 'right.addPrompt' | transloco }}
          </button>
        </div>
        <p class="mb-3 text-xs leading-relaxed text-mist/30">
          {{ 'right.yourPromptsHint' | transloco }}
        </p>

        <div class="space-y-2">
          @for (prompt of userPrompts(); track prompt.id) {
            <div class="rounded-xl border border-white/10 bg-navy/30">
              <div class="flex items-center gap-2.5 px-3 py-2">
                <button
                  type="button"
                  role="switch"
                  [attr.aria-checked]="prompt.enabled"
                  class="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                  [class]="prompt.enabled ? 'bg-accent' : 'bg-white/15'"
                  (click)="toggleUser(prompt)"
                >
                  <span
                    class="absolute top-0.5 h-4 w-4 rounded-full transition-all"
                    [class]="prompt.enabled ? 'left-4.5 bg-ink' : 'left-0.5 bg-white'"
                  ></span>
                </button>
                <button
                  type="button"
                  class="min-w-0 flex-1 truncate text-left text-sm"
                  [class]="prompt.enabled ? 'text-white' : 'text-mist/50'"
                  (click)="toggleExpanded(prompt.id)"
                >
                  {{ prompt.name }}
                </button>
                @if (isBuiltin(prompt)) {
                  <span
                    class="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-mist/40"
                  >
                    {{ 'right.builtin' | transloco }}
                  </span>
                }
                <span class="shrink-0 text-mist/30">{{ expanded(prompt.id) ? '▾' : '▸' }}</span>
              </div>

              @if (expanded(prompt.id)) {
                <div class="space-y-2 border-t border-white/10 p-3">
                  <input
                    class="w-full rounded-lg border border-white/10 bg-ink/60 px-3 py-1.5 text-sm text-mist outline-none focus:border-accent/60"
                    [placeholder]="'right.promptName' | transloco"
                    [value]="prompt.name"
                    (change)="renamePrompt(prompt, $any($event.target).value)"
                  />
                  <textarea
                    class="h-44 w-full resize-y rounded-lg border border-white/10 bg-ink/60 px-3 py-2 font-mono text-xs leading-relaxed text-mist outline-none focus:border-accent/60"
                    [value]="prompt.prompt"
                    (change)="updatePromptText(prompt, $any($event.target).value)"
                  ></textarea>
                  <div class="flex items-center justify-between">
                    @if (isBuiltin(prompt)) {
                      <button
                        type="button"
                        class="text-xs text-mist/50 transition-colors hover:text-accent"
                        (click)="resetPrompt(prompt)"
                      >
                        ↺ {{ 'right.resetPrompt' | transloco }}
                      </button>
                    } @else {
                      <span></span>
                    }
                    <button
                      type="button"
                      class="text-xs text-mist/50 transition-colors hover:text-rose-400"
                      (click)="removePrompt(prompt)"
                    >
                      {{ 'right.deletePrompt' | transloco }}
                    </button>
                  </div>
                </div>
              }
            </div>
          } @empty {
            <p class="text-sm leading-relaxed text-mist/40">
              {{ 'right.noUserPrompts' | transloco }}
            </p>
          }
        </div>
      </section>
    </div>
  `,
})
export class SystemPromptsPanel {
  protected readonly settings = inject(SettingsService);
  private readonly transloco = inject(TranslocoService);

  protected readonly builtinPrompts: readonly BuiltinPrompt[] = [
    {
      key: 'securitySystemPrompt',
      enabledKey: 'securitySystemPromptEnabled',
      labelKey: 'settings.securityPrompt',
      descriptionKey: 'settings.securityPromptHint',
    },
    {
      key: 'testingSystemPrompt',
      enabledKey: 'testingSystemPromptEnabled',
      labelKey: 'settings.testingPrompt',
      descriptionKey: 'settings.testingPromptHint',
    },
    {
      key: 'architectureSystemPrompt',
      enabledKey: 'architectureSystemPromptEnabled',
      labelKey: 'settings.architecturePrompt',
      descriptionKey: 'settings.architecturePromptHint',
    },
  ];

  private readonly expandedIds = signal<string[]>([]);

  protected readonly userPrompts = computed(
    () => this.settings.settings()?.userSystemPrompts ?? [],
  );

  protected expanded(id: string): boolean {
    return this.expandedIds().includes(id);
  }

  protected toggleExpanded(id: string): void {
    this.expandedIds.update((ids) =>
      ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id],
    );
  }

  protected builtinEnabled(prompt: BuiltinPrompt): boolean {
    return this.settings.settings()?.[prompt.enabledKey] ?? false;
  }

  protected builtinText(prompt: BuiltinPrompt): string {
    return this.settings.settings()?.[prompt.key] ?? '';
  }

  protected isBuiltin(prompt: UserSystemPrompt): boolean {
    return this.settings.originalUserSystemPrompts().some((entry) => entry.id === prompt.id);
  }

  protected editInSettings(): void {
    this.settings.open('agent');
  }

  protected async toggleBuiltin(prompt: BuiltinPrompt): Promise<void> {
    const patch = {
      [prompt.enabledKey]: !this.builtinEnabled(prompt),
    } as Partial<Settings>;
    await this.settings.patch(patch);
  }

  protected async toggleUser(prompt: UserSystemPrompt): Promise<void> {
    await this.updateUser(prompt.id, { enabled: !prompt.enabled });
  }

  protected async renamePrompt(prompt: UserSystemPrompt, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === prompt.name) {
      return;
    }
    await this.updateUser(prompt.id, { name: trimmed });
  }

  protected async updatePromptText(prompt: UserSystemPrompt, value: string): Promise<void> {
    if (value === prompt.prompt) {
      return;
    }
    await this.updateUser(prompt.id, { prompt: value });
  }

  protected async resetPrompt(prompt: UserSystemPrompt): Promise<void> {
    const original = this.settings
      .originalUserSystemPrompts()
      .find((entry) => entry.id === prompt.id);
    if (!original) {
      return;
    }
    await this.updateUser(prompt.id, { name: original.name, prompt: original.prompt });
  }

  protected async removePrompt(prompt: UserSystemPrompt): Promise<void> {
    await this.settings.patch({
      userSystemPrompts: this.userPrompts().filter((entry) => entry.id !== prompt.id),
    });
  }

  protected async addPrompt(): Promise<void> {
    const id = `custom-${Date.now().toString(36)}`;
    const prompt: UserSystemPrompt = {
      id,
      name: this.transloco.translate('right.customPrompt'),
      prompt: '',
      enabled: true,
    };
    await this.settings.patch({ userSystemPrompts: [...this.userPrompts(), prompt] });
    this.toggleExpanded(id);
  }

  private async updateUser(id: string, changes: Partial<UserSystemPrompt>): Promise<void> {
    await this.settings.patch({
      userSystemPrompts: this.userPrompts().map((entry) =>
        entry.id === id ? { ...entry, ...changes } : entry,
      ),
    });
  }
}
