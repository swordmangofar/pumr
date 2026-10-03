import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ModelInfo } from '../core/models';
import { providerModelId } from '../core/api';
import { ModelsService } from '../core/models.service';
import { ProvidersService } from '../core/providers.service';
import { SettingsService } from '../core/settings.service';
import { ProviderMark } from './provider-mark';

/** Group id of the favorites at the top of the model picker (not a provider). */
const FAVORITES_GROUP = '__favorites';
const MAX_PICKER_ROWS = 200;
const PROVIDER_FILTER_KEY = 'pumr.modelProviderFilter';

function readProviderFilter(): string {
  try {
    return localStorage.getItem(PROVIDER_FILTER_KEY) || 'all';
  } catch {
    return 'all';
  }
}

export function formatModelPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatModelContext(value: number): string {
  if (!value) {
    return '—';
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  return value >= 1000 ? `${Math.round(value / 1000)}k` : `${value}`;
}

/**
 * The searchable model list shared by the composer and the settings: provider
 * chips, favorites first, then one group per provider. The host positions it.
 */
@Component({
  selector: 'app-model-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, ProviderMark],
  host: {
    class: 'flex flex-col overflow-hidden glass-pop rounded-2xl shadow-2xl',
  },
  template: `
    <input
      #search
      class="field-flush px-4 py-2.5 text-sm"
      [value]="filter()"
      [placeholder]="'composer.searchModel' | transloco"
      [attr.aria-label]="'composer.searchModel' | transloco"
      (input)="onFilter($event)"
    />
    @if (pickerProviders().length > 1 && !only()) {
      <div
        class="flex shrink-0 gap-1 overflow-x-auto border-b border-white/5 px-3 py-2"
        role="group"
        [attr.aria-label]="'right.provider' | transloco"
      >
        <button
          type="button"
          class="shrink-0 rounded-full px-2.5 py-1 text-xs transition-colors"
          [class]="
            providerFilter() === 'all'
              ? 'bg-white/15 text-white'
              : 'text-mist/50 hover:bg-white/5 hover:text-mist'
          "
          [attr.aria-pressed]="providerFilter() === 'all'"
          (click)="setProviderFilter('all')"
        >
          {{ 'composer.allProviders' | transloco }}
        </button>
        @for (entry of pickerProviders(); track entry.id) {
          <button
            type="button"
            class="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors"
            [class]="
              providerFilter() === entry.id
                ? 'bg-white/15 text-white'
                : 'text-mist/50 hover:bg-white/5 hover:text-mist'
            "
            [attr.aria-pressed]="providerFilter() === entry.id"
            (click)="setProviderFilter(entry.id)"
          >
            <app-provider-mark [provider]="entry.id" size="xs" />
            {{ entry.name }}
            <span class="text-mist/35">{{ entry.count }}</span>
          </button>
        }
      </div>
    }
    <div class="min-h-0 flex-1 overflow-y-auto">
      @if (clearLabel(); as label) {
        <button
          type="button"
          class="flex w-full items-center border-b border-white/5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-white/5"
          [class]="selected() ? 'text-mist/60' : 'bg-accent/10 text-white'"
          data-model-clear
          (click)="picked.emit(null)"
        >
          {{ label }}
        </button>
      }
      @for (group of modelGroups(); track group.id) {
        <div
          class="flex items-center gap-2 border-b border-white/5 bg-white/[0.03] px-4 py-1.5 text-[11px] font-semibold tracking-widest text-mist/45 uppercase"
          [attr.data-model-group]="group.id"
        >
          @if (group.id === favoritesGroup) {
            <svg
              class="h-3.5 w-3.5 text-amber-300"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="m10 2.6 2.3 4.7 5.1.7-3.7 3.6.9 5.1L10 14.3l-4.6 2.4.9-5.1L2.6 8l5.1-.7z" />
            </svg>
            {{ 'composer.favorites' | transloco }}
          } @else {
            <app-provider-mark [provider]="group.id" size="xs" />
            {{ group.name }}
          }
        </div>
        @for (model of group.models; track model.id) {
          <div
            class="flex items-stretch border-b border-white/5 transition-colors hover:bg-white/5"
            [class]="model.id === selected() ? 'bg-accent/10' : ''"
          >
            <button
              type="button"
              class="min-w-0 flex-1 px-4 py-2.5 text-left"
              (click)="picked.emit(model.id)"
            >
              <div class="flex items-center justify-between gap-3">
                <span class="flex min-w-0 items-center gap-2">
                  @if (group.id === favoritesGroup) {
                    <app-provider-mark [provider]="model.source" size="xs" />
                  }
                  <span class="truncate text-sm text-white">{{ model.name }}</span>
                </span>
                <span class="shrink-0 text-xs text-mist/40">
                  {{ price(model.promptPricePerM) }} /
                  {{ price(model.completionPricePerM) }}
                </span>
              </div>
              <div class="mt-1 flex items-center gap-2 text-xs text-mist/30">
                <span class="truncate">
                  @if (group.id === favoritesGroup) {
                    {{ providers.name(model.source) }} ·
                  }
                  {{ providerModelId(model.id) }}
                </span>
                <span
                  class="shrink-0"
                  [attr.title]="
                    ('provider.context' | transloco) + ': ' + model.contextLength.toLocaleString()
                  "
                  >{{ context(model.contextLength) }}</span
                >
                @if (model.supportsReasoning) {
                  <span class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-accent">{{
                    'composer.reasoning' | transloco
                  }}</span>
                }
                @if (model.supportsVision) {
                  <span class="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-mist/60">{{
                    'composer.vision' | transloco
                  }}</span>
                }
                @if (model.supportsTools) {
                  <span
                    class="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300"
                    >{{ 'composer.tools' | transloco }}</span
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
                (isFavorite(model.id) ? 'composer.unfavorite' : 'composer.favorite') | transloco
              "
              [attr.title]="
                (isFavorite(model.id) ? 'composer.unfavorite' : 'composer.favorite') | transloco
              "
              (click)="toggleFavorite(model.id)"
            >
              <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  d="m10 2.6 2.3 4.7 5.1.7-3.7 3.6.9 5.1L10 14.3l-4.6 2.4.9-5.1L2.6 8l5.1-.7z"
                />
              </svg>
            </button>
          </div>
        }
      } @empty {
        <p class="px-4 py-5 text-center text-sm text-mist/40">
          {{ 'composer.noModels' | transloco }}
        </p>
      }
    </div>
  `,
})
export class ModelMenu {
  protected readonly modelsService = inject(ModelsService);
  protected readonly providers = inject(ProvidersService);
  private readonly settings = inject(SettingsService);

  /** Id of the model that is currently chosen, highlighted in the list. */
  readonly selected = input<string | null>(null);
  /** When set, a first row with this label picks "no model" (`null`). */
  readonly clearLabel = input<string | null>(null);
  /** When set, only the models with these ids are listed. */
  readonly only = input<readonly string[] | null>(null);
  readonly picked = output<string | null>();

  protected readonly providerModelId = providerModelId;
  protected readonly favoritesGroup = FAVORITES_GROUP;
  protected readonly price = formatModelPrice;
  protected readonly context = formatModelContext;
  protected readonly filter = signal('');
  /** Which provider's models the picker shows; persisted per device. */
  protected readonly providerFilter = signal(readProviderFilter());
  private readonly searchRef = viewChild<ElementRef<HTMLInputElement>>('search');

  private readonly favoriteModels = computed(() => this.settings.settings()?.favoriteModels ?? []);
  /** The models the picker offers: all of them, or the ones named by `only`. */
  private readonly offered = computed(() => {
    const only = this.only();
    const models = this.modelsService.models();
    return only ? models.filter((model) => only.includes(model.id)) : models;
  });

  /** Providers that have models in the picker, in catalog order, with counts. */
  protected readonly pickerProviders = computed(() => {
    const counts = new Map<string, number>();
    for (const model of this.offered()) {
      counts.set(model.source, (counts.get(model.source) ?? 0) + 1);
    }
    const order = this.providers.providers().map((provider) => provider.id);
    const rank = (id: string) => {
      const index = order.indexOf(id);
      return index < 0 ? order.length : index;
    };
    return [...counts.entries()]
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([id, count]) => ({ id, name: this.providers.name(id), count }));
  });
  /**
   * The picker's rows: favorites first, then one group per provider, filtered
   * by the provider chip and the search term (which also matches provider names).
   */
  protected readonly modelGroups = computed(() => {
    const term = this.filter().trim().toLowerCase();
    const providers = this.pickerProviders();
    const selected = this.providerFilter();
    // A short list of suggestions is shown whole, whatever provider was picked last.
    const active =
      !this.only() && providers.some((entry) => entry.id === selected) ? selected : 'all';
    const favorites = new Set(this.favoriteModels());
    const matches = this.offered().filter(
      (model) =>
        (active === 'all' || model.source === active) &&
        (!term ||
          model.name.toLowerCase().includes(term) ||
          model.id.toLowerCase().includes(term) ||
          this.providers.name(model.source).toLowerCase().includes(term)),
    );
    const groups: { id: string; name: string; models: ModelInfo[] }[] = [];
    let budget = MAX_PICKER_ROWS;
    const favored = matches.filter((model) => favorites.has(model.id)).slice(0, budget);
    if (favored.length > 0) {
      groups.push({ id: FAVORITES_GROUP, name: '', models: favored });
      budget -= favored.length;
    }
    for (const entry of providers) {
      if (budget <= 0) {
        break;
      }
      const list = matches
        .filter((model) => model.source === entry.id && !favorites.has(model.id))
        .slice(0, budget);
      if (list.length > 0) {
        groups.push({ id: entry.id, name: entry.name, models: list });
        budget -= list.length;
      }
    }
    return groups;
  });

  constructor() {
    afterNextRender(() => this.searchRef()?.nativeElement.focus());
  }

  protected setProviderFilter(id: string): void {
    this.providerFilter.set(id);
    try {
      localStorage.setItem(PROVIDER_FILTER_KEY, id);
    } catch {
      // Not remembered; the picker still filters for now.
    }
  }

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
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
}
