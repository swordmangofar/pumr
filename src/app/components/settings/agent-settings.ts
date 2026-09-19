import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { SettingsService } from '../../core/settings.service';
import { SettingsDraftService } from './settings-draft.service';

type OptionalPromptKey =
  'securitySystemPrompt' | 'testingSystemPrompt' | 'architectureSystemPrompt';

type OptionalPromptEnabledKey =
  'securitySystemPromptEnabled' | 'testingSystemPromptEnabled' | 'architectureSystemPromptEnabled';

interface OptionalPrompt {
  key: OptionalPromptKey;
  enabledKey: OptionalPromptEnabledKey;
  labelKey: string;
  descriptionKey: string;
}

@Component({
  selector: 'app-agent-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <section>
      <div class="mb-2 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <label class="block text-sm font-semibold text-white">
            {{ 'settings.systemPrompt' | transloco }}
          </label>
          @if (customized()) {
            <span
              class="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300"
            >
              {{ 'settings.systemPromptCustomized' | transloco }}
            </span>
          }
        </div>
        @if (customized() || promptChanged()) {
          <button
            type="button"
            class="rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5"
            (click)="resetSystemPrompt()"
          >
            {{ 'settings.systemPromptReset' | transloco }}
          </button>
        }
      </div>
      <textarea
        class="h-56 w-full resize-y rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm leading-relaxed text-mist outline-none focus:border-accent/60"
        [value]="draft.draft().defaultSystemPrompt"
        (input)="draft.patch('defaultSystemPrompt', $any($event.target).value)"
      ></textarea>
      @if (promptChanged() && draftCustomized()) {
        <p
          class="mt-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-200"
        >
          {{ 'settings.systemPromptWarning' | transloco }}
        </p>
      } @else if (customized()) {
        <p class="mt-2 text-xs leading-relaxed text-amber-300/80">
          {{ 'settings.systemPromptCustomizedHint' | transloco }}
        </p>
      }
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.systemPromptHint' | transloco }}</p>
    </section>

    @for (prompt of optionalPrompts; track prompt.key) {
      <section class="mt-8">
        <div class="mb-2 flex items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              [attr.aria-checked]="isEnabled(prompt)"
              class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
              [class]="isEnabled(prompt) ? 'bg-accent' : 'bg-white/15'"
              (click)="togglePrompt(prompt)"
            >
              <span
                class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
                [class]="isEnabled(prompt) ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
              ></span>
            </button>
            <div class="flex items-center gap-2">
              <label class="block text-sm font-semibold text-white">
                {{ prompt.labelKey | transloco }}
              </label>
              @if (isCustomized(prompt)) {
                <span
                  class="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300"
                >
                  {{ 'settings.systemPromptCustomized' | transloco }}
                </span>
              }
            </div>
          </div>
          @if (isCustomized(prompt) || isChanged(prompt)) {
            <button
              type="button"
              class="rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5"
              (click)="resetPrompt(prompt)"
            >
              {{ 'settings.systemPromptReset' | transloco }}
            </button>
          }
        </div>
        <textarea
          class="h-40 w-full resize-y rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm leading-relaxed text-mist outline-none transition-opacity focus:border-accent/60"
          [class.opacity-50]="!isEnabled(prompt)"
          [value]="promptValue(prompt)"
          (input)="setPrompt(prompt, $any($event.target).value)"
        ></textarea>
        @if (isChanged(prompt) && isCustomized(prompt)) {
          <p
            class="mt-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-200"
          >
            {{ 'settings.systemPromptWarning' | transloco }}
          </p>
        }
        <p class="mt-2 text-xs text-mist/30">{{ prompt.descriptionKey | transloco }}</p>
      </section>
    }

    <section class="mt-8 grid grid-cols-2 gap-6">
      <div>
        <label class="mb-2 block text-sm text-mist/50">{{ 'settings.budget' | transloco }}</label>
        <input
          type="number"
          min="0"
          step="0.5"
          class="w-full rounded-xl border border-white/10 bg-ink/60 px-4 py-2 text-sm text-mist outline-none focus:border-accent/60"
          [value]="draft.draft().budgetUsd"
          (input)="draft.patch('budgetUsd', +$any($event.target).value)"
        />
        <p class="mt-2 text-xs text-mist/30">{{ 'settings.budgetHint' | transloco }}</p>
      </div>

      <div>
        <label class="mb-2 block text-sm text-mist/50">{{
          'settings.contextLimit' | transloco
        }}</label>
        <input
          type="number"
          min="0"
          step="5"
          class="w-full rounded-xl border border-white/10 bg-ink/60 px-4 py-2 text-sm text-mist outline-none focus:border-accent/60"
          [value]="draft.draft().contextMessageLimit"
          (input)="draft.patch('contextMessageLimit', +$any($event.target).value)"
        />
        <p class="mt-2 text-xs text-mist/30">{{ 'settings.contextLimitHint' | transloco }}</p>
      </div>
    </section>

    <section class="mt-8">
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.commandRules' | transloco }}
      </label>
      <div class="space-y-1.5">
        @for (rule of commandRules(); track rule) {
          <div
            class="flex items-center justify-between rounded-xl border border-white/10 bg-ink/40 px-4 py-2"
          >
            <code class="font-mono text-sm text-mist">{{ rule }}</code>
            <button
              type="button"
              class="text-mist/40 transition-colors hover:text-rose-400"
              (click)="deleteRule(rule)"
            >
              ✕
            </button>
          </div>
        } @empty {
          <p class="text-sm text-mist/30">{{ 'settings.noCommandRules' | transloco }}</p>
        }
      </div>
      <div class="mt-3 flex gap-2">
        <input
          class="min-w-0 flex-1 rounded-xl border border-white/10 bg-ink/60 px-4 py-2 font-mono text-sm text-mist outline-none focus:border-accent/60"
          [placeholder]="'settings.rulePlaceholder' | transloco"
          [value]="newRule()"
          (input)="newRule.set($any($event.target).value)"
          (keydown.enter)="addRule()"
        />
        <button
          type="button"
          class="rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5"
          (click)="addRule()"
        >
          {{ 'settings.addRule' | transloco }}
        </button>
      </div>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.commandRulesHint' | transloco }}</p>
    </section>

    <section class="mt-8">
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.websiteRules' | transloco }}
      </label>
      <div class="space-y-1.5">
        @for (rule of allowedWebsites(); track rule) {
          <div
            class="flex items-center justify-between rounded-xl border border-white/10 bg-ink/40 px-4 py-2"
          >
            <code class="font-mono text-sm text-emerald-300">{{ rule }}</code>
            <button
              type="button"
              class="text-mist/40 transition-colors hover:text-rose-400"
              (click)="deleteWebsite(rule, true)"
            >
              ✕
            </button>
          </div>
        } @empty {
          <p class="text-sm text-mist/30">{{ 'settings.noAllowedWebsites' | transloco }}</p>
        }
      </div>
      <div class="mt-3 space-y-1.5">
        @for (rule of deniedWebsites(); track rule) {
          <div
            class="flex items-center justify-between rounded-xl border border-rose-500/20 bg-ink/40 px-4 py-2"
          >
            <code class="font-mono text-sm text-rose-300">{{ rule }}</code>
            <button
              type="button"
              class="text-mist/40 transition-colors hover:text-rose-400"
              (click)="deleteWebsite(rule, false)"
            >
              ✕
            </button>
          </div>
        } @empty {
          <p class="text-sm text-mist/30">{{ 'settings.noDeniedWebsites' | transloco }}</p>
        }
      </div>
      <div class="mt-3 flex gap-2">
        <input
          class="min-w-0 flex-1 rounded-xl border border-white/10 bg-ink/60 px-4 py-2 font-mono text-sm text-mist outline-none focus:border-accent/60"
          [placeholder]="'settings.websitePlaceholder' | transloco"
          [value]="newWebsite()"
          (input)="newWebsite.set($any($event.target).value)"
          (keydown.enter)="addWebsite(true)"
        />
        <button
          type="button"
          class="rounded-full border border-emerald-500/30 px-4 py-2 text-sm text-emerald-300 transition-colors hover:bg-emerald-500/10"
          (click)="addWebsite(true)"
        >
          {{ 'settings.allowWebsite' | transloco }}
        </button>
        <button
          type="button"
          class="rounded-full border border-rose-500/30 px-4 py-2 text-sm text-rose-300 transition-colors hover:bg-rose-500/10"
          (click)="addWebsite(false)"
        >
          {{ 'settings.denyWebsite' | transloco }}
        </button>
      </div>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.websiteRulesHint' | transloco }}</p>
    </section>
  `,
})
export class AgentSettings {
  protected readonly draft = inject(SettingsDraftService);
  private readonly settingsService = inject(SettingsService);

  protected readonly newRule = signal('');
  protected readonly commandRules = () => this.settingsService.settings()?.commandRules ?? [];
  protected readonly newWebsite = signal('');
  protected readonly allowedWebsites = () => this.settingsService.settings()?.allowedWebsites ?? [];
  protected readonly deniedWebsites = () => this.settingsService.settings()?.deniedWebsites ?? [];

  protected readonly customized = computed(() => {
    const saved = this.settingsService.settings()?.defaultSystemPrompt ?? '';
    return saved.trim() !== this.settingsService.originalSystemPrompts().defaultSystemPrompt.trim();
  });

  protected readonly draftCustomized = computed(
    () =>
      (this.draft.draft().defaultSystemPrompt ?? '').trim() !==
      this.settingsService.originalSystemPrompts().defaultSystemPrompt.trim(),
  );

  protected readonly promptChanged = computed(
    () =>
      this.draft.draft().defaultSystemPrompt !==
      (this.settingsService.settings()?.defaultSystemPrompt ?? ''),
  );

  protected resetSystemPrompt(): void {
    this.draft.patch(
      'defaultSystemPrompt',
      this.settingsService.originalSystemPrompts().defaultSystemPrompt,
    );
  }

  protected readonly optionalPrompts: readonly OptionalPrompt[] = [
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

  protected promptValue(prompt: OptionalPrompt): string {
    return this.draft.draft()[prompt.key];
  }

  protected isEnabled(prompt: OptionalPrompt): boolean {
    return this.draft.draft()[prompt.enabledKey];
  }

  protected originalPrompt(prompt: OptionalPrompt): string {
    return this.settingsService.originalSystemPrompts()[prompt.key];
  }

  protected isCustomized(prompt: OptionalPrompt): boolean {
    const saved = this.settingsService.settings()?.[prompt.key] ?? '';
    return saved.trim() !== this.originalPrompt(prompt).trim();
  }

  protected isChanged(prompt: OptionalPrompt): boolean {
    return this.promptValue(prompt) !== (this.settingsService.settings()?.[prompt.key] ?? '');
  }

  protected togglePrompt(prompt: OptionalPrompt): void {
    this.draft.patch(prompt.enabledKey, !this.isEnabled(prompt));
  }

  protected setPrompt(prompt: OptionalPrompt, value: string): void {
    this.draft.patch(prompt.key, value);
  }

  protected resetPrompt(prompt: OptionalPrompt): void {
    this.draft.patch(prompt.key, this.originalPrompt(prompt));
  }

  protected async addRule(): Promise<void> {
    const rule = this.newRule().trim();
    if (!rule) {
      return;
    }
    await this.settingsService.addCommandRule(rule);
    this.newRule.set('');
  }

  protected async deleteRule(rule: string): Promise<void> {
    await this.settingsService.deleteCommandRule(rule);
  }

  protected async addWebsite(allow: boolean): Promise<void> {
    const rule = this.newWebsite().trim();
    if (!rule) {
      return;
    }
    await this.settingsService.addWebsiteRule(rule, allow);
    this.newWebsite.set('');
  }

  protected async deleteWebsite(rule: string, allow: boolean): Promise<void> {
    await this.settingsService.deleteWebsiteRule(rule, allow);
  }
}
