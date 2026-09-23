import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { api } from '../../core/api';
import {
  InstalledSkill,
  MarketplacePlugin,
  SkillCandidate,
  SkillMarketplace,
  SkillState,
} from '../../core/models';
import { RECOMMENDED_MARKETPLACES, RecommendedMarketplace } from '../../core/recommendations';
import { FolderList } from './folder-list';
import { MarketplaceRegistryService } from './marketplace-registry.service';
import { SettingsDraftService } from './settings-draft.service';
import { Toggle } from '../toggle';

import { TypedInput } from '../typed-input';

interface SkillListing {
  marketplace: SkillMarketplace;
  plugin: MarketplacePlugin;
}

@Component({
  selector: 'app-skills-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MarketplaceRegistryService],
  imports: [TypedInput, TranslocoPipe, FolderList, Toggle],
  template: `
    <section class="flex items-center justify-between gap-4">
      <div>
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.skills.autoDiscovery' | transloco }}
        </h3>
        <p class="mt-1 text-xs leading-relaxed text-mist/30">
          {{ 'settings.skills.autoDiscoveryHint' | transloco }}
        </p>
      </div>
      <button
        type="button"
        class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        [class]="draft.draft().skillsAutoDiscovery ? 'bg-accent' : 'bg-white/15'"
        (click)="draft.patch('skillsAutoDiscovery', !draft.draft().skillsAutoDiscovery)"
      >
        <span
          class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
          [class]="draft.draft().skillsAutoDiscovery ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
        ></span>
      </button>
    </section>

    <section class="mt-8">
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.skills.folders' | transloco }}
      </h3>
      <p class="mb-3 text-xs leading-relaxed text-mist/30">
        {{ 'settings.skills.foldersHint' | transloco }}
      </p>
      <app-folder-list
        [folders]="draft.draft().skillFolders"
        (changed)="draft.patch('skillFolders', $event)"
        addLabel="settings.skills.addFolder"
      />
    </section>

    <section class="mt-8">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.skills.detected' | transloco }}
        </h3>
        <button
          type="button"
          class="rounded-full border border-white/15 px-3.5 py-1.5 text-xs text-mist transition-colors hover:bg-white/5"
          (click)="refresh()"
        >
          ↻ {{ 'common.refresh' | transloco }}
        </button>
      </div>

      @if (loading()) {
        <p class="text-sm text-mist/30">{{ 'common.loading' | transloco }}</p>
      }

      <div class="space-y-1.5">
        @for (candidate of candidates(); track candidate.path) {
          <div class="rounded-xl border border-white/10 bg-ink/40 px-4 py-3">
            <div class="flex items-center gap-2.5">
              <button
                type="button"
                class="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                [class]="candidate.enabled ? 'bg-accent' : 'bg-white/15'"
                (click)="toggle(candidate)"
              >
                <span
                  class="absolute top-0.5 h-4 w-4 rounded-full transition-all"
                  [class]="candidate.enabled ? 'left-4.5 bg-ink' : 'left-0.5 bg-white'"
                ></span>
              </button>
              <span class="truncate text-sm text-mist">{{ candidate.label }}</span>
              <span class="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-xs text-mist/40">
                {{ candidate.source }}
              </span>
            </div>
            <p class="mt-1 truncate font-mono text-xs text-mist/30">{{ candidate.path }}</p>
            @if (candidate.skills.length > 0) {
              <div class="mt-2 space-y-1.5">
                @for (skill of candidate.skills; track skill.name) {
                  <div class="flex items-center gap-2.5">
                    <app-toggle
                      size="xs"
                      [checked]="skill.enabled"
                      [disabled]="!candidate.enabled"
                      (toggled)="toggleSkill(candidate, skill)"
                    />
                    <span
                      [class]="
                        'truncate text-xs ' +
                        (skill.enabled ? 'text-mist' : 'text-mist/30 line-through')
                      "
                    >
                      {{ skill.name }}
                    </span>
                  </div>
                }
              </div>
            } @else {
              <p class="mt-1 text-xs text-mist/20">{{ 'settings.skills.noSkills' | transloco }}</p>
            }
          </div>
        } @empty {
          @if (!loading()) {
            <p class="text-sm text-mist/30">{{ 'settings.skills.noSources' | transloco }}</p>
          }
        }
      </div>

      <p class="mt-4 text-xs leading-relaxed text-mist/30">
        {{ 'settings.skills.phaseNote' | transloco }}
      </p>
    </section>

    <section class="mt-8">
      <h3 class="text-sm font-semibold text-white">
        {{ 'settings.skills.marketplaces' | transloco }}
      </h3>
      <p class="mb-3 mt-1 text-xs leading-relaxed text-mist/30">
        {{ 'settings.skills.marketplacesHint' | transloco }}
      </p>

      <div class="mb-3 flex items-center gap-3">
        <app-toggle
          size="sm"
          [checked]="draft.draft().marketplaceVerifiedOnly"
          (toggled)="toggleVerifiedOnly()"
        />
        <span class="text-xs text-mist/50">
          {{ 'settings.skills.verifiedOnly' | transloco }}
        </span>
      </div>
      <p class="mb-3 text-xs leading-relaxed text-mist/30">
        {{ 'settings.skills.verifiedOnlyHint' | transloco }}
      </p>

      <h4 class="mb-1 text-xs font-semibold uppercase tracking-wide text-mist/40">
        {{ 'settings.skills.recommended' | transloco }}
      </h4>
      <p class="mb-2 text-xs leading-relaxed text-mist/30">
        {{ 'settings.skills.recommendedHint' | transloco }}
      </p>
      <div class="mb-3 grid gap-1.5 sm:grid-cols-2">
        @for (item of recommended; track item.url) {
          <div class="flex flex-col rounded-xl border border-white/10 bg-ink/40 px-4 py-3">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm text-mist">{{ item.nameKey | transloco }}</span>
              <button
                type="button"
                class="ml-auto shrink-0 rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
                [disabled]="isAdded(item) || addingRecommended() === item.url || adding()"
                (click)="addRecommended(item)"
              >
                {{
                  (isAdded(item)
                    ? 'settings.skills.added'
                    : addingRecommended() === item.url
                      ? 'common.loading'
                      : 'settings.skills.add'
                  ) | transloco
                }}
              </button>
            </div>
            <p class="mt-1 text-xs leading-relaxed text-mist/50">
              {{ item.descriptionKey | transloco }}
            </p>
          </div>
        }
      </div>

      <div class="flex gap-2">
        <input
          type="url"
          class="field min-w-0 flex-1 rounded-xl px-4 py-2 text-sm"
          [value]="newUrl()"
          [placeholder]="'settings.skills.marketplaceUrl' | transloco"
          (typedValue)="newUrl.set($event)"
          (keydown.enter)="addMarketplace()"
        />
        <button
          type="button"
          class="shrink-0 rounded-xl border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
          [disabled]="adding()"
          (click)="addMarketplace()"
        >
          {{ 'settings.skills.add' | transloco }}
        </button>
      </div>

      @if (registry.error()) {
        <p class="mt-3 text-sm text-red-400">{{ registry.error() }}</p>
      }

      @if (adding()) {
        <p class="mt-3 text-sm text-mist/30">{{ 'common.loading' | transloco }}</p>
      }

      <div class="mt-3 space-y-1.5">
        @for (marketplace of marketplaces(); track marketplace.name) {
          <div class="rounded-xl border border-white/10 bg-ink/40 px-4 py-3">
            <div class="flex items-center gap-2">
              @if (marketplace.verified) {
                <span
                  class="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300"
                  [attr.title]="'settings.skills.verifiedTooltip' | transloco"
                >
                  {{ 'settings.skills.verified' | transloco }}
                </span>
              } @else if (marketplace.trusted) {
                <span
                  class="shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs text-sky-300"
                  [attr.title]="'settings.skills.trustedTooltip' | transloco"
                >
                  {{ 'settings.skills.trusted' | transloco }}
                </span>
              } @else {
                <span
                  class="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300"
                  [attr.title]="'settings.skills.unverifiedTooltip' | transloco"
                >
                  {{ 'settings.skills.unverified' | transloco }}
                </span>
              }
              @if (marketplace.spoofedName) {
                <span
                  class="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300"
                  [attr.title]="'settings.skills.reservedNameTooltip' | transloco"
                >
                  {{ 'settings.skills.reservedName' | transloco }}
                </span>
              }
              <span class="truncate text-sm text-mist">{{ marketplace.name }}</span>
              @if (marketplace.owner) {
                <span class="shrink-0 text-xs text-mist/30">{{ marketplace.owner }}</span>
              }
              @if (marketplace.trusted) {
                <button
                  type="button"
                  class="ml-auto shrink-0 rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
                  [disabled]="removing() === marketplace.url"
                  (click)="removeMarketplace(marketplace)"
                >
                  {{ 'common.remove' | transloco }}
                </button>
              }
            </div>
            @if (marketplace.description) {
              <p class="mt-1 text-xs leading-relaxed text-mist/50">
                {{ marketplace.description }}
              </p>
            }
            @if (marketplace.url) {
              <p class="mt-1 truncate font-mono text-xs text-mist/30">{{ marketplace.url }}</p>
            }
          </div>
        } @empty {
          @if (!adding()) {
            <p class="text-sm text-mist/30">{{ 'settings.skills.noMarketplaces' | transloco }}</p>
          }
        }
      </div>

      @if (listings().length > 0) {
        <div class="mt-6">
          <input
            type="search"
            class="field w-full rounded-xl px-4 py-2 text-sm"
            [value]="searchQuery()"
            [placeholder]="'settings.skills.searchPlaceholder' | transloco"
            (typedValue)="searchQuery.set($event)"
          />

          @if (categories().length > 0) {
            <div class="mt-3 flex flex-wrap gap-1.5">
              <button
                type="button"
                class="rounded-full px-3 py-1 text-xs transition-colors"
                [class]="
                  effectiveCategory() === 'all'
                    ? 'bg-accent text-ink'
                    : 'border border-white/15 text-mist hover:bg-white/5'
                "
                (click)="activeCategory.set('all')"
              >
                {{ 'settings.skills.allCategories' | transloco }}
              </button>
              @for (category of categories(); track category) {
                <button
                  type="button"
                  class="rounded-full px-3 py-1 text-xs transition-colors"
                  [class]="
                    effectiveCategory() === category
                      ? 'bg-accent text-ink'
                      : 'border border-white/15 text-mist hover:bg-white/5'
                  "
                  (click)="activeCategory.set(category)"
                >
                  {{ category }}
                </button>
              }
            </div>
          }

          <p class="mt-3 text-xs text-mist/40">
            {{ 'settings.skills.browseCount' | transloco: { count: visibleListings().length } }}
          </p>

          <div class="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            @for (listing of visibleListings(); track listingKey(listing)) {
              <div class="flex flex-col rounded-2xl border border-white/10 bg-ink/40 p-4">
                <h4 class="truncate text-sm font-semibold text-white">
                  {{ listing.plugin.name }}
                </h4>
                @if (listing.plugin.category) {
                  <span
                    class="mt-2 w-fit rounded-full bg-white/10 px-2.5 py-0.5 text-xs text-mist/50"
                  >
                    {{ listing.plugin.category }}
                  </span>
                }
                <p class="mt-2 line-clamp-2 min-h-10 text-xs leading-relaxed text-mist/50">
                  {{ listing.plugin.description || listing.marketplace.description || '' }}
                </p>
                @if (listing.plugin.skills.length > 0) {
                  <p class="mt-2 truncate text-xs text-mist/30">
                    {{ listing.plugin.skills.join(', ') }}
                  </p>
                }
                <div class="mt-3 flex items-center gap-2 text-xs text-mist/30">
                  <span class="truncate">
                    {{ listing.marketplace.owner || listing.marketplace.name }}
                  </span>
                  @if (listing.marketplace.verified) {
                    <span
                      class="shrink-0 text-emerald-300"
                      [attr.title]="'settings.skills.verifiedTooltip' | transloco"
                    >
                      {{ 'settings.skills.verified' | transloco }}
                    </span>
                  } @else if (listing.marketplace.trusted) {
                    <span
                      class="shrink-0 text-sky-300"
                      [attr.title]="'settings.skills.trustedTooltip' | transloco"
                    >
                      {{ 'settings.skills.trusted' | transloco }}
                    </span>
                  }
                </div>
                <div class="mt-auto flex items-center gap-3 pt-4 text-xs">
                  <button
                    type="button"
                    class="flex items-center gap-1.5 text-mist/60 transition-colors hover:text-mist"
                    (click)="copyListing(listing)"
                  >
                    <svg
                      class="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                    >
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                    </svg>
                    {{
                      (copied() === listingKey(listing)
                        ? 'settings.skills.copied'
                        : 'common.copy'
                      ) | transloco
                    }}
                  </button>
                  <button
                    type="button"
                    class="flex items-center gap-1.5 text-mist/60 transition-colors hover:text-mist disabled:opacity-40"
                    [disabled]="
                      isInstalling(listing) || !listing.marketplace.url || isBlocked(listing.marketplace)
                    "
                    (click)="install(listing.marketplace, listing.plugin.name)"
                  >
                    <svg
                      class="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                    >
                      <path d="M12 3v12" />
                      <path d="m7 10 5 5 5-5" />
                      <path d="M5 21h14" />
                    </svg>
                    {{
                      (isInstalling(listing) ? 'common.installing' : 'common.download') | transloco
                    }}
                  </button>
                  @if (listingRepository(listing); as repository) {
                    <button
                      type="button"
                      class="flex items-center gap-1.5 text-mist/60 transition-colors hover:text-mist"
                      (click)="openRepository(repository)"
                    >
                      <svg
                        class="h-3.5 w-3.5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                      >
                        <path d="M15 3h6v6" />
                        <path d="M10 14 21 3" />
                        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                      </svg>
                      {{ 'common.github' | transloco }}
                    </button>
                  }
                </div>
              </div>
            } @empty {
              <p class="text-sm text-mist/30">{{ 'settings.skills.noResults' | transloco }}</p>
            }
          </div>
        </div>
      }
    </section>

    <section class="mt-8">
      <h3 class="text-sm font-semibold text-white">
        {{ 'settings.skills.installed' | transloco }}
      </h3>
      <p class="mb-3 mt-1 text-xs leading-relaxed text-mist/30">
        {{ 'settings.skills.installedHint' | transloco }}
      </p>

      <div class="space-y-1.5">
        @for (skill of installed(); track skill.path) {
          <div
            class="flex items-center gap-2 rounded-xl border border-white/10 bg-ink/40 px-4 py-3"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-mist">{{ skill.name }}</p>
              <p class="truncate text-xs text-mist/30">{{ skill.marketplace }}</p>
            </div>
            <button
              type="button"
              class="shrink-0 rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5"
              (click)="uninstall(skill)"
            >
              {{ 'common.uninstall' | transloco }}
            </button>
          </div>
        } @empty {
          <p class="text-sm text-mist/30">{{ 'settings.skills.noInstalled' | transloco }}</p>
        }
      </div>
    </section>
  `,
})
export class SkillsSettings {
  protected readonly draft = inject(SettingsDraftService);
  protected readonly registry = inject(MarketplaceRegistryService);
  private readonly transloco = inject(TranslocoService);
  protected readonly recommended = RECOMMENDED_MARKETPLACES;
  protected readonly candidates = signal<SkillCandidate[]>([]);
  protected readonly loading = signal(false);
  protected readonly marketplaces = signal<SkillMarketplace[]>([]);
  protected readonly installed = signal<InstalledSkill[]>([]);
  protected readonly newUrl = signal('');
  protected readonly adding = signal(false);
  protected readonly addingRecommended = signal<string | null>(null);
  protected readonly removing = signal<string | null>(null);
  protected readonly installing = signal<string | null>(null);
  protected readonly searchQuery = signal('');
  protected readonly activeCategory = signal('all');
  protected readonly copied = signal<string | null>(null);

  private readonly query = computed(() => {
    const draft = this.draft.draft();
    return JSON.stringify({
      folders: draft.skillFolders,
      disabled: draft.skillsDisabled,
      disabledItems: draft.skillsDisabledItems,
      auto: draft.skillsAutoDiscovery,
    });
  });

  protected readonly listings = computed<SkillListing[]>(() =>
    this.marketplaces().flatMap((marketplace) =>
      marketplace.plugins.map((plugin) => ({ marketplace, plugin })),
    ),
  );

  protected readonly categories = computed(() => {
    const categories = new Set<string>();
    for (const listing of this.listings()) {
      if (listing.plugin.category) {
        categories.add(listing.plugin.category);
      }
    }
    return [...categories].sort((a, b) => a.localeCompare(b));
  });

  protected readonly effectiveCategory = computed(() => {
    const active = this.activeCategory();
    return active !== 'all' && this.categories().includes(active) ? active : 'all';
  });

  protected readonly visibleListings = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const category = this.effectiveCategory();
    return this.listings().filter(({ marketplace, plugin }) => {
      if (category !== 'all' && plugin.category !== category) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        plugin.name,
        plugin.description ?? '',
        marketplace.name,
        marketplace.owner ?? '',
        ...plugin.keywords,
        ...plugin.skills,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  });

  constructor() {
    effect(() => {
      this.query();
      void this.refresh();
    });
    void this.loadMarketplace();
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const draft = this.draft.draft();
      this.candidates.set(
        await api.discoverSkills(
          draft.skillFolders,
          draft.skillsDisabled,
          draft.skillsDisabledItems,
          draft.skillsAutoDiscovery,
        ),
      );
    } finally {
      this.loading.set(false);
    }
  }

  protected toggle(candidate: SkillCandidate): void {
    const disabled = this.draft.draft().skillsDisabled;
    this.draft.patch(
      'skillsDisabled',
      candidate.enabled
        ? [...disabled, candidate.path]
        : disabled.filter((entry) => entry !== candidate.path),
    );
  }

  protected toggleSkill(candidate: SkillCandidate, skill: SkillState): void {
    if (!candidate.enabled) {
      return;
    }
    const disabled = this.draft.draft().skillsDisabledItems;
    const matches = (entry: { path: string; name: string }): boolean =>
      entry.path === candidate.path && entry.name === skill.name;
    this.draft.patch(
      'skillsDisabledItems',
      disabled.some(matches)
        ? disabled.filter((entry) => !matches(entry))
        : [...disabled, { path: candidate.path, name: skill.name }],
    );
  }

  private async loadMarketplace(): Promise<void> {
    const { marketplaces, installed } = await this.registry.loadSkills();
    this.marketplaces.set(marketplaces);
    this.installed.set(installed);
  }

  protected async addMarketplace(): Promise<void> {
    const url = this.newUrl().trim();
    if (!url || this.adding()) {
      return;
    }
    this.adding.set(true);
    try {
      if (await this.registry.addMarketplace(url)) {
        this.newUrl.set('');
        await this.loadMarketplace();
      }
    } finally {
      this.adding.set(false);
    }
  }

  protected isAdded(item: RecommendedMarketplace): boolean {
    return this.marketplaces().some((marketplace) => marketplace.url === item.url);
  }

  protected async addRecommended(item: RecommendedMarketplace): Promise<void> {
    if (this.isAdded(item) || this.addingRecommended()) {
      return;
    }
    this.addingRecommended.set(item.url);
    try {
      if (await this.registry.addMarketplace(item.url)) {
        await this.loadMarketplace();
      }
    } finally {
      this.addingRecommended.set(null);
    }
  }

  protected async removeMarketplace(marketplace: SkillMarketplace): Promise<void> {
    if (!marketplace.url || this.removing()) {
      return;
    }
    this.removing.set(marketplace.url);
    try {
      if (await this.registry.removeMarketplace(marketplace.url)) {
        await this.loadMarketplace();
      }
    } finally {
      this.removing.set(null);
    }
  }

  protected async install(marketplace: SkillMarketplace, plugin: string): Promise<void> {
    if (!marketplace.url || this.installing()) {
      return;
    }
    this.installing.set(this.keyFor(marketplace, plugin));
    try {
      const installed = await this.registry.installSkills(
        marketplace.url,
        plugin,
        !this.draft.draft().marketplaceVerifiedOnly,
      );
      if (installed) {
        await this.loadMarketplace();
        await this.refresh();
      }
    } finally {
      this.installing.set(null);
    }
  }

  protected listingKey(listing: SkillListing): string {
    return this.keyFor(listing.marketplace, listing.plugin.name);
  }

  protected isInstalling(listing: SkillListing): boolean {
    return this.installing() === this.listingKey(listing);
  }

  protected listingRepository(listing: SkillListing): string | null {
    return listing.plugin.repository ?? listing.plugin.homepage ?? listing.marketplace.url;
  }

  protected async copyListing(listing: SkillListing): Promise<void> {
    const reference = listing.plugin.skills.length
      ? listing.plugin.skills.join('\n')
      : listing.plugin.name;
    try {
      await navigator.clipboard.writeText(reference);
      this.copied.set(this.listingKey(listing));
      setTimeout(() => this.copied.set(null), 1500);
    } catch {
      this.registry.error.set(this.transloco.translate('common.clipboardError'));
    }
  }

  protected openRepository(url: string): void {
    void api.openExternalUrl(url);
  }

  private keyFor(marketplace: SkillMarketplace, plugin: string): string {
    return `${marketplace.url ?? marketplace.name}::${plugin}`;
  }

  protected isBlocked(marketplace: SkillMarketplace): boolean {
    return (
      this.draft.draft().marketplaceVerifiedOnly && !marketplace.verified && !marketplace.trusted
    );
  }

  protected async toggleVerifiedOnly(): Promise<void> {
    this.draft.patch('marketplaceVerifiedOnly', !this.draft.draft().marketplaceVerifiedOnly);
    await this.draft.save();
  }

  protected async uninstall(skill: InstalledSkill): Promise<void> {
    if (await this.registry.uninstallSkills(skill.marketplace, skill.name)) {
      await this.loadMarketplace();
      await this.refresh();
    }
  }
}
