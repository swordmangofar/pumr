import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { EndpointInfo } from '../core/models';
import { ModelsService } from '../core/models.service';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';

const REASONING_OPTIONS = ['off', 'low', 'medium', 'high'];

const PROVIDER_PRESETS = [
  {
    value: 'auto:throughput',
    key: 'provider.presetThroughput',
    hint: 'provider.presetThroughputHint',
  },
  {
    value: 'auto:price',
    key: 'provider.presetPrice',
    hint: 'provider.presetPriceHint',
  },
  {
    value: 'auto:value',
    key: 'provider.presetValue',
    hint: 'provider.presetValueHint',
  },
] as const;

@Component({
  selector: 'app-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <div class="border-t border-white/10 bg-ink/40 px-4 pt-3 pb-3">
      <div
        class="relative mx-auto w-full max-w-4xl rounded-2xl border border-white/10 bg-navy/30 shadow-lg shadow-black/20 transition-colors focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/15"
      >
        <textarea
          #input
          class="block max-h-[min(45vh,22rem)] min-h-[5.5rem] w-full resize-none overflow-y-auto bg-transparent px-4 pt-3.5 pr-3 pb-1 text-[15px] leading-relaxed text-white outline-none placeholder:text-mist/50"
          rows="1"
          enterkeyhint="send"
          [attr.aria-label]="'chat.placeholder' | transloco"
          [value]="draft()"
          [placeholder]="'chat.placeholder' | transloco"
          (input)="onInput($event)"
          (keydown)="onKeydown($event)"
        ></textarea>

        <div class="flex items-end justify-between gap-2 border-t border-white/5 px-4 py-2">
          <div class="flex min-w-0 flex-wrap items-center gap-1.5">
            <!-- Model picker -->
            <div>
              <button
                type="button"
                class="flex h-8 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 text-sm text-mist transition-colors hover:border-accent/40 hover:text-white"
                [attr.aria-expanded]="modelOpen()"
                [attr.aria-controls]="modelOpen() ? 'composer-model-menu' : null"
                (click)="modelOpen.set(!modelOpen())"
                (keydown.escape)="closeMenus()"
              >
                <span class="max-w-56 truncate">{{
                  selectedModel()?.name ?? ('composer.noModels' | transloco)
                }}</span>
                <svg
                  class="h-3.5 w-3.5 shrink-0 text-mist/40"
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

              @if (modelOpen()) {
                <div class="fixed inset-0 z-30" (click)="modelOpen.set(false)"></div>
                <div
                  class="absolute bottom-full left-0 z-40 mb-2 flex max-h-[min(24rem,50vh)] w-[min(30rem,100%)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-navy shadow-2xl"
                  id="composer-model-menu"
                  (keydown.escape)="closeMenus()"
                >
                  <input
                    class="border-b border-white/10 bg-transparent px-4 py-2.5 text-sm text-white outline-none placeholder:text-mist/50"
                    [value]="modelFilter()"
                    [placeholder]="'composer.searchModel' | transloco"
                    [attr.aria-label]="'composer.searchModel' | transloco"
                    (input)="onFilter($event)"
                    autofocus
                  />
                  <div class="min-h-0 flex-1 overflow-y-auto">
                    @for (model of filteredModels(); track model.id) {
                      <div
                        class="flex items-stretch border-b border-white/5 transition-colors hover:bg-white/5"
                        [class]="model.id === selectedModel()?.id ? 'bg-accent/10' : ''"
                      >
                        <button
                          type="button"
                          class="min-w-0 flex-1 px-4 py-2.5 text-left"
                          (click)="selectModel(model.id)"
                        >
                          <div class="flex items-center justify-between gap-3">
                            <span class="truncate text-sm text-white">{{ model.name }}</span>
                            <span class="shrink-0 text-xs text-mist/40">
                              {{ price(model.promptPricePerM) }} /
                              {{ price(model.completionPricePerM) }}
                            </span>
                          </div>
                          <div class="mt-1 flex items-center gap-2 text-xs text-mist/30">
                            <span class="truncate">{{ model.id }}</span>
                            <span
                              class="shrink-0"
                              [attr.title]="
                                ('provider.context' | transloco) +
                                ': ' +
                                model.contextLength.toLocaleString()
                              "
                              >{{ context(model.contextLength) }}</span
                            >
                            @if (model.supportsReasoning) {
                              <span
                                class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-accent"
                                >reasoning</span
                              >
                            }
                            @if (model.supportsVision) {
                              <span
                                class="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-mist/60"
                                >vision</span
                              >
                            }
                            @if (model.supportsTools) {
                              <span
                                class="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300"
                                >tools</span
                              >
                            }
                          </div>
                        </button>
                        <button
                          type="button"
                          class="flex shrink-0 items-center px-3 transition-colors"
                          [class]="
                            isFavorite(model.id)
                              ? 'text-amber-300 hover:text-amber-200'
                              : 'text-mist/40 hover:text-amber-200'
                          "
                          [attr.aria-label]="
                            (isFavorite(model.id) ? 'composer.unfavorite' : 'composer.favorite')
                              | transloco
                          "
                          [attr.title]="
                            (isFavorite(model.id) ? 'composer.unfavorite' : 'composer.favorite')
                              | transloco
                          "
                          (click)="toggleFavorite(model.id)"
                        >
                          <svg
                            class="h-4 w-4"
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <path
                              d="m10 2.6 2.3 4.7 5.1.7-3.7 3.6.9 5.1L10 14.3l-4.6 2.4.9-5.1L2.6 8l5.1-.7z"
                            />
                          </svg>
                        </button>
                      </div>
                    } @empty {
                      <p class="px-4 py-5 text-center text-sm text-mist/40">
                        {{ 'composer.noModels' | transloco }}
                      </p>
                    }
                  </div>
                </div>
              }
            </div>

            <!-- Reasoning -->
            <div
              class="flex h-8 overflow-hidden rounded-full border border-white/10 bg-white/5 p-0.5"
              role="group"
              [attr.aria-label]="'composer.reasoning' | transloco"
            >
              @for (option of reasoningOptions; track option) {
                <button
                  type="button"
                  class="rounded-full px-2.5 text-sm transition-colors disabled:opacity-30"
                  [class]="
                    option === reasoning()
                      ? 'bg-accent font-medium text-ink'
                      : 'text-mist/50 hover:text-mist'
                  "
                  [attr.aria-pressed]="option === reasoning()"
                  [attr.aria-label]="'reasoning.' + option | transloco"
                  [attr.title]="'reasoning.' + option | transloco"
                  [disabled]="!supportsReasoning() && option !== 'off'"
                  (click)="selectReasoning(option)"
                >
                  {{ 'reasoning.' + option | transloco }}
                </button>
              }
            </div>

            <!-- Provider picker -->
            <div>
              <button
                type="button"
                class="flex h-8 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 text-sm text-mist transition-colors hover:border-accent/40 hover:text-white"
                [attr.aria-expanded]="providerOpen()"
                [attr.aria-controls]="providerOpen() ? 'composer-provider-menu' : null"
                (click)="toggleProvider()"
                (keydown.escape)="closeMenus()"
              >
                <span class="flex min-w-0 items-center gap-1.5">
                  @if (presetKey(provider()); as key) {
                    <svg
                      class="h-3.5 w-3.5 shrink-0 text-accent"
                      viewBox="0 0 20 20"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        [attr.d]="presetIcon(provider())"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                    <span class="max-w-40 truncate">{{ key | transloco }}</span>
                  } @else {
                    @if (provider() !== 'auto') {
                      @if (providerIcon(provider()); as icon) {
                        <img
                          [src]="icon"
                          alt=""
                          class="h-3.5 w-3.5 shrink-0 rounded object-contain"
                          (error)="providerIconError(provider())"
                        />
                      }
                    }
                    <span class="max-w-40 truncate">
                      @if (provider() === 'auto') {
                        {{ 'provider.auto' | transloco }}
                      } @else {
                        {{ providerLabel() }}
                      }
                    </span>
                  }
                </span>
                <svg
                  class="h-3.5 w-3.5 shrink-0 text-mist/40"
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

              @if (providerOpen()) {
                <div class="fixed inset-0 z-30" (click)="providerOpen.set(false)"></div>
                <div
                  class="absolute bottom-full left-0 z-40 mb-2 max-h-[min(24rem,50vh)] w-[min(32rem,100%)] overflow-y-auto rounded-2xl border border-white/10 bg-navy shadow-2xl"
                  id="composer-provider-menu"
                  (keydown.escape)="closeMenus()"
                >
                  <div class="border-b border-white/10">
                    <button
                      type="button"
                      class="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-white/5"
                      [class]="provider() === 'auto' ? 'bg-accent/10 text-white' : 'text-mist'"
                      (click)="selectAutoProvider()"
                    >
                      <svg
                        class="h-4 w-4 shrink-0 text-accent"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="m10 2 1.6 4.4L16 8l-4.4 1.6L10 14l-1.6-4.4L4 8l4.4-1.6z" />
                      </svg>
                      <span class="flex-1">{{ 'provider.auto' | transloco }}</span>
                      @if (provider() === 'auto') {
                        <svg
                          class="h-4 w-4 shrink-0 text-accent"
                          viewBox="0 0 20 20"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M5 10.5 9 14.5 15.5 6"
                            stroke="currentColor"
                            stroke-width="1.8"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      }
                    </button>
                    @for (preset of providerPresets; track preset.value) {
                      <button
                        type="button"
                        class="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-white/5"
                        [class]="provider() === preset.value ? 'bg-accent/10 text-white' : 'text-mist'"
                        [attr.title]="preset.hint | transloco"
                        (click)="selectPreset(preset.value)"
                      >
                        <svg
                          class="h-4 w-4 shrink-0 text-accent"
                          viewBox="0 0 20 20"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            [attr.d]="presetIcon(preset.value)"
                            stroke="currentColor"
                            stroke-width="1.6"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                        <span class="flex-1">{{ preset.key | transloco }}</span>
                        @if (provider() === preset.value) {
                          <svg
                            class="h-4 w-4 shrink-0 text-accent"
                            viewBox="0 0 20 20"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              d="M5 10.5 9 14.5 15.5 6"
                              stroke="currentColor"
                              stroke-width="1.8"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            />
                          </svg>
                        }
                      </button>
                    }
                  </div>
                  @if (modelsService.endpointsLoading()[model()]) {
                    <p class="px-4 py-4 text-center text-sm text-mist/40">
                      {{ 'common.loading' | transloco }}
                    </p>
                  }
                  @for (endpoint of endpoints(); track endpoint.slug + endpoint.name) {
                    <button
                      type="button"
                      class="block w-full border-b border-white/5 px-4 py-2.5 text-left transition-colors hover:bg-white/5"
                      (click)="selectProvider(endpoint)"
                    >
                      <div class="flex items-center justify-between gap-3">
                        <span class="flex min-w-0 items-center gap-2">
                          @if (providerIcon(endpoint.providerSlug); as icon) {
                            <img
                              [src]="icon"
                              alt=""
                              class="h-5 w-5 shrink-0 rounded object-contain"
                              (error)="providerIconError(endpoint.providerSlug)"
                            />
                          } @else {
                            <span
                              class="grid h-5 w-5 shrink-0 place-items-center rounded bg-white/10 text-[10px] font-semibold text-mist/60"
                            >
                              {{ initial(endpoint.providerName) }}
                            </span>
                          }
                          <span class="truncate text-sm text-white">{{
                            endpoint.providerName
                          }}</span>
                          @if (endpoint.training) {
                            <span
                              class="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
                              [attr.title]="'provider.trainsHint' | transloco"
                            >
                              {{ 'provider.trains' | transloco }}
                            </span>
                          }
                          @if (endpoint.quantization) {
                            <span
                              class="shrink-0 rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] text-mist/40"
                            >
                              {{ endpoint.quantization }}
                            </span>
                          }
                        </span>
                        <span
                          class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums"
                          [style.color]="priceColor(endpoint)"
                          [style.background-color]="priceBackground(endpoint)"
                          [attr.title]="'provider.priceHint' | transloco"
                        >
                          {{ price(endpoint.promptPricePerM) }} /
                          {{ price(endpoint.completionPricePerM) }}
                        </span>
                      </div>
                      <div class="mt-1.5 flex items-center gap-3 text-xs text-mist/40">
                        @if (uptime(endpoint); as up) {
                          <span
                            class="flex items-center gap-1.5 font-medium"
                            [style.color]="uptimeColor(endpoint)"
                            [attr.title]="'provider.uptime' | transloco"
                          >
                            <span
                              class="h-1.5 w-1.5 shrink-0 rounded-full"
                              [style.background-color]="uptimeColor(endpoint)"
                            ></span>
                            {{ up.toFixed(1) }}%
                          </span>
                        }
                        @if (endpoint.throughputLast30m !== null) {
                          <span [attr.title]="'provider.tokensPerSecond' | transloco">
                            {{ endpoint.throughputLast30m.toFixed(0) }} tok/s
                          </span>
                        }
                        @if (endpoint.latencyLast30m !== null) {
                          <span [attr.title]="'provider.latency' | transloco">
                            {{ endpoint.latencyLast30m.toFixed(0) }} ms
                          </span>
                        }
                        <span
                          [attr.title]="
                            ('provider.context' | transloco) +
                            ': ' +
                            endpoint.contextLength.toLocaleString()
                          "
                        >
                          {{ context(endpoint.contextLength) }}
                        </span>
                        @if (region(endpoint.slug); as reg) {
                          <span class="text-mist/40">{{ reg }}</span>
                        }
                      </div>
                    </button>
                  } @empty {
                    @if (!modelsService.endpointsLoading()[model()]) {
                      <p class="px-4 py-4 text-center text-sm text-mist/40">
                        @if (modelsService.endpointsError()[model()]; as err) {
                          {{ err }}
                        } @else {
                          {{ 'composer.noModels' | transloco }}
                        }
                      </p>
                    }
                  }
                </div>
              }
            </div>
          </div>

          <div class="flex shrink-0 items-center gap-1.5">
            @if (streaming()) {
              <button
                type="button"
                class="flex h-8 min-w-28 items-center justify-center gap-1.5 rounded-full bg-rose-500/15 px-4 text-sm font-medium text-rose-300 transition-colors hover:bg-rose-500/25"
                (click)="stop()"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="6" width="8" height="8" rx="1.5" />
                </svg>
                {{ 'chat.stop' | transloco }}
              </button>
            } @else {
              <button
                type="button"
                class="flex h-8 min-w-28 items-center justify-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-ink transition-colors hover:bg-accent/90 disabled:opacity-40"
                [disabled]="!canSend()"
                (click)="send()"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path d="M4 16V4l12 6z" />
                </svg>
                {{ 'chat.send' | transloco }}
              </button>
            }
          </div>
        </div>
      </div>

      <p class="mx-auto mt-1.5 hidden w-full max-w-4xl px-1 text-xs text-mist/40 sm:block">
        {{ 'chat.hint' | transloco }}
      </p>
    </div>
  `,
})
export class Composer {
  protected readonly workspace = inject(WorkspaceService);
  protected readonly settings = inject(SettingsService);
  protected readonly modelsService = inject(ModelsService);

  protected readonly reasoningOptions = REASONING_OPTIONS;
  protected readonly providerPresets = PROVIDER_PRESETS;
  protected readonly draft = signal('');
  protected readonly modelOpen = signal(false);
  protected readonly providerOpen = signal(false);
  protected readonly modelFilter = signal('');

  private readonly inputRef = viewChild<ElementRef<HTMLTextAreaElement>>('input');

  private readonly modelOverride = signal<{ sessionId: string; value: string } | null>(null);
  private readonly reasoningOverride = signal<{ sessionId: string; value: string } | null>(null);
  private readonly providerOverride = signal<{ sessionId: string; value: string } | null>(null);
  private readonly failedIcons = signal<ReadonlySet<string>>(new Set<string>());

  protected readonly model = computed(() => {
    const session = this.workspace.activeAgent();
    const override = this.modelOverride();
    if (session && override?.sessionId === session.id) {
      return override.value;
    }
    return session?.model ?? this.settings.settings()?.defaultModel ?? '';
  });
  protected readonly reasoning = computed(() => {
    const session = this.workspace.activeAgent();
    const override = this.reasoningOverride();
    if (session && override?.sessionId === session.id) {
      return override.value;
    }
    return session?.reasoningEffort ?? this.settings.settings()?.defaultReasoningEffort ?? 'medium';
  });
  protected readonly provider = computed(() => {
    const session = this.workspace.activeAgent();
    const override = this.providerOverride();
    if (session && override?.sessionId === session.id) {
      return override.value;
    }
    return session?.provider || 'auto';
  });
  protected readonly selectedModel = computed(() => this.modelsService.byId(this.model()));
  protected readonly favoriteModels = computed(
    () => this.settings.settings()?.favoriteModels ?? [],
  );
  protected readonly endpoints = computed(() => this.modelsService.endpoints()[this.model()] ?? []);
  protected readonly supportsReasoning = computed(
    () => this.selectedModel()?.supportsReasoning ?? false,
  );
  protected readonly streaming = computed(() => {
    const session = this.workspace.activeAgent();
    return session ? this.workspace.isStreaming(session.id) : false;
  });
  protected readonly canSend = computed(
    () => this.draft().trim().length > 0 && !!this.model() && !this.streaming(),
  );
  protected readonly filteredModels = computed(() => {
    const filter = this.modelFilter().trim().toLowerCase();
    const favorites = new Set(this.favoriteModels());
    const models = this.modelsService.models();
    const filtered = filter
      ? models.filter(
          (model) =>
            model.name.toLowerCase().includes(filter) || model.id.toLowerCase().includes(filter),
        )
      : models;
    const sorted = [...filtered].sort(
      (a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)),
    );
    return sorted.slice(0, 200);
  });
  protected readonly providerLabel = computed(() => {
    const provider = this.provider();
    const endpoint = this.endpoints().find(
      (entry) => entry.slug === provider || entry.slug.split('/')[0] === provider,
    );
    return endpoint?.providerName ?? provider;
  });
  private readonly priceRange = computed(() => {
    const prices = this.endpoints()
      .map((endpoint) => endpoint.promptPricePerM)
      .filter((value) => value > 0);
    if (prices.length === 0) {
      return { min: 0, max: 0 };
    }
    return { min: Math.min(...prices), max: Math.max(...prices) };
  });

  constructor() {
    void this.modelsService.loadProviders();
    effect(() => {
      const model = this.model();
      if (model) {
        untracked(() => void this.modelsService.loadEndpoints(model));
      }
    });
    effect(() => {
      const draft = this.workspace.pendingDraft();
      if (draft !== null) {
        this.draft.set(draft);
        this.workspace.consumeDraft();
      }
    });
    effect(() => {
      this.draft();
      this.autoGrow();
    });
  }

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
    this.autoGrow();
  }

  private autoGrow(): void {
    const element = this.inputRef()?.nativeElement;
    if (!element) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }

  private focusInput(): void {
    this.inputRef()?.nativeElement.focus();
  }

  protected onFilter(event: Event): void {
    this.modelFilter.set((event.target as HTMLInputElement).value);
  }

  protected closeMenus(): void {
    if (this.modelOpen() || this.providerOpen()) {
      this.modelOpen.set(false);
      this.providerOpen.set(false);
      this.focusInput();
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === 'Escape' && (this.modelOpen() || this.providerOpen())) {
      this.closeMenus();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !this.modelOpen() && !this.providerOpen()) {
      event.preventDefault();
      void this.send();
    }
  }

  protected async send(): Promise<void> {
    const session = this.workspace.activeAgent();
    const content = this.draft().trim();
    const model = this.model();
    if (!session || !content || !model || this.streaming()) {
      return;
    }
    this.draft.set('');
    await this.workspace.send({
      sessionId: session.id,
      content,
      model,
      reasoningEffort: this.reasoning(),
      provider: this.provider() === 'auto' ? null : this.provider(),
    });
    this.focusInput();
  }

  protected async stop(): Promise<void> {
    const session = this.workspace.activeAgent();
    if (session) {
      await this.workspace.stop(session.id);
    }
  }

  protected async selectModel(modelId: string): Promise<void> {
    const session = this.workspace.activeAgent();
    this.modelOverride.set(session ? { sessionId: session.id, value: modelId } : null);
    this.providerOverride.set(session ? { sessionId: session.id, value: 'auto' } : null);
    this.modelOpen.set(false);
    this.focusInput();
    if (session) {
      await this.workspace.updateSession({ sessionId: session.id, model: modelId, provider: '' });
    }
  }

  protected isFavorite(modelId: string): boolean {
    return this.favoriteModels().includes(modelId);
  }

  protected async toggleFavorite(modelId: string): Promise<void> {
    const current = this.favoriteModels();
    const next = current.includes(modelId)
      ? current.filter((id) => id !== modelId)
      : [...current, modelId];
    await this.settings.patch({ favoriteModels: next });
  }

  protected async selectReasoning(option: string): Promise<void> {
    const session = this.workspace.activeAgent();
    this.reasoningOverride.set(session ? { sessionId: session.id, value: option } : null);
    if (session) {
      await this.workspace.updateSession({ sessionId: session.id, reasoningEffort: option });
    }
  }

  protected toggleProvider(): void {
    const opening = !this.providerOpen();
    if (opening) {
      const model = this.model();
      if (model) {
        void this.modelsService.loadEndpoints(model);
      }
    }
    this.providerOpen.set(opening);
  }

  protected async selectProvider(endpoint: EndpointInfo): Promise<void> {
    const session = this.workspace.activeAgent();
    const slug = endpoint.slug.split('/')[0] || endpoint.providerName;
    this.providerOverride.set(session ? { sessionId: session.id, value: slug } : null);
    this.providerOpen.set(false);
    this.focusInput();
    if (session) {
      await this.workspace.updateSession({ sessionId: session.id, provider: slug });
    }
  }

  protected async selectAutoProvider(): Promise<void> {
    const session = this.workspace.activeAgent();
    this.providerOverride.set(session ? { sessionId: session.id, value: 'auto' } : null);
    this.providerOpen.set(false);
    this.focusInput();
    if (session) {
      await this.workspace.updateSession({ sessionId: session.id, provider: '' });
    }
  }

  protected async selectPreset(value: string): Promise<void> {
    const session = this.workspace.activeAgent();
    this.providerOverride.set(session ? { sessionId: session.id, value } : null);
    this.providerOpen.set(false);
    this.focusInput();
    if (session) {
      await this.workspace.updateSession({ sessionId: session.id, provider: value });
    }
  }

  protected presetKey(value: string): string | null {
    return this.providerPresets.find((preset) => preset.value === value)?.key ?? null;
  }

  protected presetIcon(value: string): string {
    switch (value) {
      case 'auto:throughput':
        return 'M11 2 4 11h5l-1 7 7-9h-5z';
      case 'auto:price':
        return 'M10 3v14M13 6.5H8.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H7';
      default:
        return 'M3 16l4.5-5 3 3L17 7M14 7h3v3';
    }
  }

  protected region(slug: string): string | null {
    const parts = slug.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : null;
  }

  protected providerIcon(slug: string): string | null {
    if (this.failedIcons().has(slug)) {
      return null;
    }
    return this.modelsService.providerIcon(slug);
  }

  protected providerIconError(slug: string): void {
    this.failedIcons.update((set) => new Set(set).add(slug));
  }

  protected initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }

  protected uptime(endpoint: EndpointInfo): number | null {
    return endpoint.uptimeLast30m ?? endpoint.uptimeLast1d ?? null;
  }

  protected uptimeColor(endpoint: EndpointInfo): string {
    const value = this.uptime(endpoint);
    if (value === null) {
      return 'rgba(255,255,255,0.25)';
    }
    if (value >= 99) {
      return '#34d399';
    }
    if (value >= 95) {
      return '#fbbf24';
    }
    return '#fb7185';
  }

  private priceTier(endpoint: EndpointInfo): number {
    const { min, max } = this.priceRange();
    if (max <= min) {
      return 0;
    }
    return Math.min(1, Math.max(0, (endpoint.promptPricePerM - min) / (max - min)));
  }

  protected priceColor(endpoint: EndpointInfo): string {
    return `hsl(${140 - 140 * this.priceTier(endpoint)} 72% 72%)`;
  }

  protected priceBackground(endpoint: EndpointInfo): string {
    return `hsl(${140 - 140 * this.priceTier(endpoint)} 72% 50% / 0.16)`;
  }

  protected price(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  protected context(value: number): string {
    if (!value) {
      return '—';
    }
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    }
    return value >= 1000 ? `${Math.round(value / 1000)}k` : `${value}`;
  }
}
