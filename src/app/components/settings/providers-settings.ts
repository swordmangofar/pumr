import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ModelsService } from '../../core/models.service';
import { SettingsService } from '../../core/settings.service';
import { SettingsDraftService } from './settings-draft.service';

const REASONING_OPTIONS = ['off', 'low', 'medium', 'high'];
const PLANNED_PROVIDERS = ['Anthropic', 'OpenAI', 'Google', 'xAI'];

import { TypedInput } from '../typed-input';

@Component({
  selector: 'app-providers-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe],
  template: `
    <section
      #apiKeySection
      class="-m-3 rounded-2xl p-3 transition-shadow"
      [class]="highlight() ? 'ring-2 ring-accent/60' : ''"
    >
      <div class="mb-2 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.providers.openrouter' | transloco }}
        </h3>
        <span
          class="rounded-full px-2.5 py-0.5 text-xs font-medium"
          [class]="
            settingsService.hasApiKey()
              ? 'bg-emerald-500/15 text-emerald-300'
              : 'bg-rose-500/15 text-rose-300'
          "
        >
          {{
            (settingsService.hasApiKey() ? 'settings.keyPresent' : 'settings.keyMissing')
              | transloco
          }}
        </span>
      </div>
      <label class="mb-2 block text-sm text-mist/50">{{ 'settings.apiKey' | transloco }}</label>
      <div class="flex gap-2">
        <input
          #apiKeyInput
          type="password"
          class="field min-w-0 flex-1 rounded-xl px-4 py-2 text-sm"
          placeholder="sk-or-v1-..."
          [value]="apiKeyDraft()"
          (typedValue)="apiKeyDraft.set($event)"
          (keydown.enter)="saveApiKey()"
        />
        <button
          type="button"
          class="rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5"
          (click)="saveApiKey()"
        >
          {{ 'settings.save' | transloco }}
        </button>
        <button
          type="button"
          class="rounded-full border border-rose-500/30 px-4 py-2 text-sm text-rose-300 transition-colors hover:bg-rose-500/10"
          (click)="settingsService.deleteApiKey()"
        >
          {{ 'settings.delete' | transloco }}
        </button>
      </div>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.apiKeyHint' | transloco }}</p>
    </section>

    <section class="mt-8">
      <label class="mb-2 block text-sm text-mist/50">{{ 'settings.baseUrl' | transloco }}</label>
      <input
        class="field w-full rounded-xl px-4 py-2 font-mono text-sm"
        [value]="draft.draft().openrouterBaseUrl"
        (typedValue)="draft.patch('openrouterBaseUrl', $event)"
      />
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.baseUrlHint' | transloco }}</p>
    </section>

    <section class="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div>
        <label class="mb-2 block text-sm text-mist/50">{{
          'settings.defaultModel' | transloco
        }}</label>
        <input
          list="pumr-models"
          class="field w-full rounded-xl px-4 py-2 text-sm"
          placeholder="anthropic/claude-sonnet-4"
          [value]="draft.draft().defaultModel ?? ''"
          (input)="onModelInput($event)"
        />
        <datalist id="pumr-models">
          @for (model of modelsService.models(); track model.id) {
            <option [value]="model.id">{{ model.name }}</option>
          }
        </datalist>
        <p class="mt-2 text-xs text-mist/30">{{ 'settings.defaultModelHint' | transloco }}</p>
      </div>

      <div>
        <label class="mb-2 block text-sm text-mist/50">{{
          'settings.defaultReasoning' | transloco
        }}</label>
        <div class="flex overflow-hidden rounded-full border border-white/10 bg-white/5 p-0.5">
          @for (option of reasoningOptions; track option) {
            <button
              type="button"
              class="flex-1 rounded-full px-3 py-1.5 text-sm transition-colors"
              [class]="
                option === (draft.draft().defaultReasoningEffort ?? 'medium')
                  ? 'bg-accent font-medium text-ink'
                  : 'text-mist/50 hover:text-mist'
              "
              (click)="draft.patch('defaultReasoningEffort', option)"
            >
              {{ 'reasoning.' + option | transloco }}
            </button>
          }
        </div>
      </div>
    </section>

    <section class="mt-8">
      <label class="mb-2 block text-sm text-mist/50">{{
        'settings.handoverModel' | transloco
      }}</label>
      <input
        list="pumr-handover-models"
        class="field w-full max-w-md rounded-xl px-4 py-2 text-sm"
        [placeholder]="'settings.handoverModelPlaceholder' | transloco"
        [value]="draft.draft().handoverModel ?? ''"
        (input)="onHandoverModelInput($event)"
      />
      <datalist id="pumr-handover-models">
        @for (model of modelsService.models(); track model.id) {
          <option [value]="model.id">{{ model.name }}</option>
        }
      </datalist>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.handoverModelHint' | transloco }}</p>
    </section>

    <section class="mt-8">
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.providers.future' | transloco }}
      </h3>
      <p class="mb-3 text-xs text-mist/30">{{ 'settings.providers.futureHint' | transloco }}</p>
      <div class="flex flex-wrap gap-2">
        @for (provider of plannedProviders; track provider) {
          <span
            class="rounded-full border border-white/10 bg-ink/40 px-3.5 py-1.5 text-sm text-mist/60"
          >
            {{ provider }}
            <span class="ml-1.5 rounded-full bg-white/10 px-2 py-0.5 text-xs text-mist/40">
              {{ 'settings.providers.planned' | transloco }}
            </span>
          </span>
        }
      </div>
    </section>
  `,
})
export class ProvidersSettings {
  protected readonly settingsService = inject(SettingsService);
  protected readonly draft = inject(SettingsDraftService);
  protected readonly modelsService = inject(ModelsService);

  protected readonly reasoningOptions = REASONING_OPTIONS;
  protected readonly plannedProviders = PLANNED_PROVIDERS;
  protected readonly apiKeyDraft = signal('');
  protected readonly highlight = signal(false);

  private readonly apiKeySection = viewChild<ElementRef<HTMLElement>>('apiKeySection');
  private readonly apiKeyInput = viewChild<ElementRef<HTMLInputElement>>('apiKeyInput');

  constructor() {
    afterNextRender(() => {
      if (this.settingsService.focusAnchor() !== 'apiKey') {
        return;
      }
      this.apiKeySection()?.nativeElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
      this.apiKeyInput()?.nativeElement.focus();
      this.highlight.set(true);
      setTimeout(() => this.highlight.set(false), 2000);
    });
  }

  protected onModelInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    this.draft.patch('defaultModel', value.length > 0 ? value : null);
  }

  protected onHandoverModelInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim();
    this.draft.patch('handoverModel', value.length > 0 ? value : null);
  }

  protected async saveApiKey(): Promise<void> {
    const key = this.apiKeyDraft().trim();
    if (!key) {
      return;
    }
    await this.settingsService.setApiKey(key);
    this.apiKeyDraft.set('');
  }
}
