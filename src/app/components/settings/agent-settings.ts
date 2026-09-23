import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { SettingsService } from '../../core/settings.service';
import { SettingsDraftService } from './settings-draft.service';
import { Toggle } from '../toggle';

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

import { TypedInput } from '../typed-input';

@Component({
  selector: 'app-agent-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe, Toggle],
  template: `
    <section>
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.replyLanguage' | transloco }}
      </label>
      <select
        class="field field-select w-64 rounded-xl py-2 pr-9 pl-4 text-sm"
        (typedValue)="draft.patch('replyLanguage', $event || null)"
      >
        <option value="" [selected]="!draft.draft().replyLanguage">
          {{ 'settings.replyLanguageDefault' | transloco }}
        </option>
        @for (lang of replyLanguages; track lang) {
          <option [value]="lang" [selected]="draft.draft().replyLanguage === lang">
            {{ lang }}
          </option>
        }
      </select>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.replyLanguageHint' | transloco }}</p>
    </section>

    <section class="mt-8">
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
        class="field h-56 w-full resize-y rounded-xl px-4 py-3 font-mono text-sm leading-relaxed"
        [value]="draft.draft().defaultSystemPrompt"
        (typedValue)="draft.patch('defaultSystemPrompt', $event)"
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
            <app-toggle [checked]="isEnabled(prompt)" (toggled)="togglePrompt(prompt)" />
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
          class="field h-40 w-full resize-y rounded-xl px-4 py-3 font-mono text-sm leading-relaxed transition-opacity"
          [class.opacity-50]="!isEnabled(prompt)"
          [value]="promptValue(prompt)"
          (typedValue)="setPrompt(prompt, $event)"
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
          class="field w-full rounded-xl px-4 py-2 text-sm"
          [value]="draft.draft().budgetUsd"
          (typedValue)="draft.patch('budgetUsd', +$event)"
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
          class="field w-full rounded-xl px-4 py-2 text-sm"
          [value]="draft.draft().contextMessageLimit"
          (typedValue)="draft.patch('contextMessageLimit', +$event)"
        />
        <p class="mt-2 text-xs text-mist/30">{{ 'settings.contextLimitHint' | transloco }}</p>
      </div>
    </section>

    <section class="mt-8">
      <label class="mb-2 block text-sm font-semibold text-white">
        {{ 'settings.maxToolIterations' | transloco }}
      </label>
      <input
        type="number"
        min="1"
        step="1"
        class="field w-40 rounded-xl px-4 py-2 text-sm"
        [value]="draft.draft().maxToolIterations"
        (typedValue)="draft.patch('maxToolIterations', +$event)"
      />
      <p class="mt-2 text-xs leading-relaxed text-mist/30">
        {{ 'settings.maxToolIterationsHint' | transloco }}
      </p>
    </section>

    <section class="mt-8">
      <div class="flex items-center gap-3">
        <app-toggle
          [checked]="draft.draft().autoContinueAllSessions"
          (toggled)="draft.patch('autoContinueAllSessions', !draft.draft().autoContinueAllSessions)"
        />
        <label class="text-sm font-semibold text-white">
          {{ 'settings.autoContinueAllSessions' | transloco }}
        </label>
      </div>
      <p class="mt-2 text-xs leading-relaxed text-mist/30">
        {{ 'settings.autoContinueAllSessionsHint' | transloco }}
      </p>
    </section>
  `,
})
export class AgentSettings {
  protected readonly draft = inject(SettingsDraftService);
  private readonly settingsService = inject(SettingsService);

  protected readonly replyLanguages = [
    'English',
    'German',
    'French',
    'Spanish',
    'Italian',
    'Portuguese',
    'Dutch',
    'Czech',
    'Polish',
    'Russian',
    'Ukrainian',
    'Turkish',
    'Arabic',
    'Hindi',
    'Chinese',
    'Japanese',
    'Korean',
  ];

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
}
