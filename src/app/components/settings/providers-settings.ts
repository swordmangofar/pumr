import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { OPENROUTER_PROVIDER, api } from '../../core/api';
import { ProviderStatus, Settings } from '../../core/models';
import { ModelsService } from '../../core/models.service';
import { ProvidersService } from '../../core/providers.service';
import { SettingsService } from '../../core/settings.service';
import { ModelSelect } from '../model-select';
import { ProviderMark } from '../provider-mark';
import { Toggle } from '../toggle';
import { TypedInput } from '../typed-input';
import { SettingsDraftService } from './settings-draft.service';

const REASONING_OPTIONS = ['off', 'low', 'medium', 'high'];

@Component({
  selector: 'app-providers-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe, ProviderMark, Toggle, ModelSelect],
  template: `
    <section>
      <div class="mb-1 flex items-baseline justify-between gap-3">
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.providers.title' | transloco }}
        </h3>
        <span class="text-xs text-mist/40">
          {{
            'settings.providers.connectedCount' | transloco: { count: providers.connected().length }
          }}
        </span>
      </div>
      <p class="mb-4 text-xs text-mist/40">{{ 'settings.providers.hint' | transloco }}</p>

      <input
        type="search"
        class="field w-full rounded-xl px-4 py-2 text-sm"
        [placeholder]="'settings.providers.searchPlaceholder' | transloco"
        [attr.aria-label]="'settings.providers.searchPlaceholder' | transloco"
        [value]="search()"
        (typedValue)="search.set($event)"
      />

      @for (group of groups(); track group.key) {
        @if (group.items.length > 0) {
          <h4 class="mt-5 mb-2 text-xs font-semibold tracking-widest text-mist/40 uppercase">
            {{ group.key | transloco }}
          </h4>
          <div class="space-y-2">
            @for (provider of group.items; track provider.id) {
              <div
                class="glass-inset overflow-hidden rounded-2xl border transition-shadow"
                [class]="
                  expanded() === provider.id
                    ? 'border-accent/40' +
                      (highlight() === provider.id ? ' ring-2 ring-accent/60' : '')
                    : 'border-white/5'
                "
                [attr.data-provider]="provider.id"
              >
                <button
                  type="button"
                  class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5"
                  [attr.aria-expanded]="expanded() === provider.id"
                  (click)="toggle(provider.id)"
                >
                  <app-provider-mark [provider]="provider.id" size="md" />
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-2">
                      <span class="truncate text-sm font-medium text-white">{{
                        provider.name
                      }}</span>
                      @if (provider.local) {
                        <span class="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-mist/60">
                          {{ 'settings.providers.local' | transloco }}
                        </span>
                      }
                    </span>
                    @if (provider.connected && !provider.error) {
                      <span class="block text-xs text-mist/40">
                        {{
                          'settings.providers.models'
                            | transloco: { count: modelCount(provider.id) }
                        }}
                      </span>
                    }
                  </span>
                  <span
                    class="rounded-full px-2.5 py-0.5 text-xs font-medium"
                    [class]="statusClass(provider)"
                  >
                    {{ statusKey(provider) | transloco }}
                  </span>
                  <svg
                    class="h-4 w-4 shrink-0 text-mist/40 transition-transform"
                    [class.rotate-180]="expanded() === provider.id"
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M5 7.5 10 12.5 15 7.5"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>

                @if (expanded() === provider.id) {
                  <div class="space-y-4 border-t border-white/5 px-4 py-4">
                    @if (provider.local) {
                      <p class="text-xs text-mist/50">
                        {{ 'settings.providers.localHint' | transloco }}
                      </p>
                    } @else {
                      <div>
                        <div class="mb-2 flex items-center justify-between gap-3">
                          <label
                            class="text-sm text-mist/50"
                            [attr.for]="'provider-key-' + provider.id"
                            >{{ 'settings.providers.apiKey' | transloco }}</label
                          >
                          <button
                            type="button"
                            class="text-xs text-accent hover:underline"
                            (click)="openKeysPage(provider)"
                          >
                            {{ 'settings.providers.getKey' | transloco }}
                          </button>
                        </div>
                        <div class="flex gap-2">
                          <input
                            type="password"
                            class="field min-w-0 flex-1 rounded-xl px-4 py-2 text-sm"
                            [id]="'provider-key-' + provider.id"
                            [attr.data-provider-key]="provider.id"
                            [placeholder]="
                              provider.hasKey ? '••••••••••••' : provider.keyPlaceholder || ''
                            "
                            [value]="keyDraft()"
                            (typedValue)="keyDraft.set($event)"
                            (keydown.enter)="saveKey(provider)"
                          />
                          <button
                            type="button"
                            class="rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
                            [disabled]="!keyDraft().trim()"
                            (click)="saveKey(provider)"
                          >
                            {{ 'settings.save' | transloco }}
                          </button>
                          @if (provider.hasKey) {
                            <button
                              type="button"
                              class="rounded-full border border-rose-500/30 px-4 py-2 text-sm text-rose-300 transition-colors hover:bg-rose-500/10"
                              (click)="deleteKey(provider)"
                            >
                              {{ 'settings.delete' | transloco }}
                            </button>
                          }
                        </div>
                        <p class="mt-2 text-xs text-mist/30">
                          {{ 'settings.apiKeyHint' | transloco }}
                        </p>
                      </div>
                    }

                    <label class="flex items-center justify-between gap-3">
                      <span class="text-sm text-mist/70">{{
                        'settings.providers.enabled' | transloco
                      }}</span>
                      <app-toggle
                        size="sm"
                        [checked]="provider.enabled"
                        (toggled)="setEnabled(provider, $event)"
                      />
                    </label>

                    <div>
                      <div class="mb-2 flex items-center justify-between gap-3">
                        <label
                          class="text-sm text-mist/50"
                          [attr.for]="'provider-url-' + provider.id"
                          >{{ 'settings.baseUrl' | transloco }}</label
                        >
                        @if (provider.baseUrl !== provider.defaultBaseUrl) {
                          <button
                            type="button"
                            class="text-xs text-mist/50 hover:text-white"
                            (click)="saveBaseUrl(provider, '')"
                          >
                            {{ 'settings.providers.reset' | transloco }}
                          </button>
                        }
                      </div>
                      <input
                        class="field w-full rounded-xl px-4 py-2 font-mono text-sm"
                        [id]="'provider-url-' + provider.id"
                        [placeholder]="provider.defaultBaseUrl"
                        [value]="
                          provider.baseUrl === provider.defaultBaseUrl ? '' : provider.baseUrl
                        "
                        (change)="saveBaseUrl(provider, $any($event.target).value)"
                      />
                      <p class="mt-2 text-xs text-mist/30">
                        {{ 'settings.baseUrlHint' | transloco }}
                      </p>
                    </div>

                    @if (provider.error) {
                      <p
                        class="rounded-xl bg-rose-500/10 px-3 py-2 text-xs break-words text-rose-300"
                      >
                        {{ 'settings.providers.loadError' | transloco: { error: provider.error } }}
                      </p>
                    }
                    @if (actionError(); as error) {
                      <p
                        class="rounded-xl bg-rose-500/10 px-3 py-2 text-xs break-words text-rose-300"
                      >
                        {{ error }}
                      </p>
                    }

                    @if (provider.connected) {
                      <div class="flex items-center justify-between gap-3">
                        <span class="text-xs text-mist/40">
                          @if (modelCount(provider.id) > 0) {
                            {{
                              'settings.providers.models'
                                | transloco: { count: modelCount(provider.id) }
                            }}
                          } @else if (!provider.error) {
                            {{ 'settings.providers.noModels' | transloco }}
                          }
                        </span>
                        <button
                          type="button"
                          class="rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
                          [disabled]="refreshing()"
                          (click)="refresh()"
                        >
                          {{ 'settings.providers.refresh' | transloco }}
                        </button>
                      </div>
                    }
                  </div>
                }
              </div>
            }
          </div>
        }
      }
      @if (search().trim()) {
        @if (matchCount() === 0) {
          <p class="mt-5 text-center text-sm text-mist/40">
            {{ 'settings.providers.noMatches' | transloco }}
          </p>
        }
      } @else if (morePopular() > 0 || showAll()) {
        <button
          type="button"
          class="mt-3 w-full rounded-xl border border-dashed border-white/10 px-4 py-2 text-sm text-mist/60 transition-colors hover:bg-white/5 hover:text-white"
          (click)="showAll.set(!showAll())"
        >
          {{
            showAll()
              ? ('settings.providers.showPopular' | transloco)
              : ('settings.providers.showAll' | transloco: { count: morePopular() })
          }}
        </button>
      }
      <p class="mt-3 text-xs text-mist/30">{{ 'settings.providers.catalogSource' | transloco }}</p>
    </section>

    <section class="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
      <div>
        <label class="mb-2 block text-sm text-mist/50">{{
          'settings.defaultModel' | transloco
        }}</label>
        <app-model-select
          [value]="draft.draft().defaultModel"
          [label]="'settings.defaultModel' | transloco"
          [placeholder]="'composer.noModels' | transloco"
          (valueChange)="draft.patch('defaultModel', $event)"
        />
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
      <app-model-select
        class="max-w-md"
        clearable
        [value]="draft.draft().handoverModel"
        [label]="'settings.handoverModel' | transloco"
        [placeholder]="'settings.handoverModelPlaceholder' | transloco"
        (valueChange)="draft.patch('handoverModel', $event)"
      />
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.handoverModelHint' | transloco }}</p>
    </section>

    <section class="mt-8">
      <label class="mb-2 block text-sm text-mist/50">{{
        'settings.commitMessageModel' | transloco
      }}</label>
      <app-model-select
        class="max-w-md"
        clearable
        [value]="draft.draft().commitMessageModel"
        [label]="'settings.commitMessageModel' | transloco"
        [placeholder]="'settings.commitMessageModelPlaceholder' | transloco"
        (valueChange)="draft.patch('commitMessageModel', $event)"
      />
      <p class="mt-2 text-xs text-mist/30">
        {{ 'settings.commitMessageModelHint' | transloco }}
      </p>
    </section>
  `,
})
export class ProvidersSettings {
  protected readonly settingsService = inject(SettingsService);
  protected readonly draft = inject(SettingsDraftService);
  protected readonly modelsService = inject(ModelsService);
  protected readonly providers = inject(ProvidersService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly reasoningOptions = REASONING_OPTIONS;
  protected readonly expanded = signal<string | null>(null);
  protected readonly highlight = signal<string | null>(null);
  protected readonly keyDraft = signal('');
  protected readonly actionError = signal<string | null>(null);
  protected readonly refreshing = signal(false);

  protected readonly search = signal('');
  /** Whether "Add a provider" lists every provider, not only popular ones. */
  protected readonly showAll = signal(false);
  private readonly matches = computed(() => {
    const term = this.search().trim().toLowerCase();
    return this.providers
      .providers()
      .filter(
        (provider) =>
          !term || provider.name.toLowerCase().includes(term) || provider.id.includes(term),
      );
  });
  protected readonly matchCount = computed(() => this.matches().length);
  /** Connected providers first; the rest can be added (popular ones unless searching). */
  protected readonly groups = computed(() => {
    const matches = this.matches();
    const available = matches.filter((provider) => !provider.connected);
    const everything = this.showAll() || this.search().trim().length > 0;
    return [
      {
        key: 'settings.providers.connectedSection',
        items: matches.filter((provider) => provider.connected),
      },
      {
        key: 'settings.providers.availableSection',
        items: everything
          ? available
          : available.filter((p) => p.popular || p.id === this.expanded()),
      },
    ];
  });
  /** Providers hidden behind "Show all". */
  protected readonly morePopular = computed(
    () =>
      this.providers.providers().filter((provider) => !provider.connected && !provider.popular)
        .length,
  );
  private readonly modelCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const model of this.modelsService.models()) {
      counts.set(model.source, (counts.get(model.source) ?? 0) + 1);
    }
    return counts;
  });

  constructor() {
    void this.providers.load();
    afterNextRender(() => {
      if (this.settingsService.focusAnchor() !== 'apiKey') {
        return;
      }
      // The "add a key" hint leads here: open OpenRouter unless another
      // provider is already connected.
      const target = this.providers.connected()[0]?.id ?? OPENROUTER_PROVIDER;
      this.expanded.set(target);
      this.highlight.set(target);
      setTimeout(() => this.highlight.set(null), 2000);
      setTimeout(() => {
        const input = this.host.nativeElement.querySelector<HTMLInputElement>(
          `[data-provider-key="${target}"]`,
        );
        input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        input?.focus();
      });
    });
  }

  protected modelCount(id: string): number {
    return this.modelCounts().get(id) ?? 0;
  }

  protected statusKey(provider: ProviderStatus): string {
    if (provider.connected) {
      return provider.error
        ? 'settings.providers.statusError'
        : 'settings.providers.statusConnected';
    }
    if (!provider.enabled && (provider.hasKey || provider.local)) {
      return 'settings.providers.statusOff';
    }
    return 'settings.providers.statusMissing';
  }

  protected statusClass(provider: ProviderStatus): string {
    if (provider.connected) {
      return provider.error ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300';
    }
    return 'bg-white/10 text-mist/50';
  }

  protected toggle(id: string): void {
    this.expanded.update((current) => (current === id ? null : id));
    this.keyDraft.set('');
    this.actionError.set(null);
  }

  protected openKeysPage(provider: ProviderStatus): void {
    void api.openExternalUrl(provider.keysUrl);
  }

  protected async saveKey(provider: ProviderStatus): Promise<void> {
    const key = this.keyDraft().trim();
    if (!key) {
      return;
    }
    await this.run(async () => {
      await this.providers.setKey(provider.id, key);
      this.keyDraft.set('');
      await this.refresh();
    });
  }

  protected async deleteKey(provider: ProviderStatus): Promise<void> {
    await this.run(async () => {
      await this.providers.deleteKey(provider.id);
      await this.refresh();
    });
  }

  protected async setEnabled(provider: ProviderStatus, enabled: boolean): Promise<void> {
    await this.run(async () => {
      this.adopt(await this.providers.update(provider.id, { enabled }));
      await this.refresh();
    });
  }

  protected async saveBaseUrl(provider: ProviderStatus, value: string): Promise<void> {
    await this.run(async () => {
      this.adopt(await this.providers.update(provider.id, { baseUrl: value.trim() }));
      await this.refresh();
    });
  }

  /** Reloads the model list, which also re-checks every provider. */
  protected async refresh(): Promise<void> {
    this.refreshing.set(true);
    try {
      await this.modelsService.load(true);
      await this.providers.load();
    } finally {
      this.refreshing.set(false);
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.actionError.set(null);
    try {
      await action();
    } catch (error) {
      this.actionError.set(String(error));
    }
  }

  /** Provider changes are saved right away; keep the open dialog in step. */
  private adopt(settings: Settings): void {
    this.settingsService.adopt(settings);
    this.draft.adopt({
      providers: settings.providers,
      openrouterBaseUrl: settings.openrouterBaseUrl,
    });
  }
}
