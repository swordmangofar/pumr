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
  DirectoryServer,
  MarketplaceServer,
  McpCandidate,
  McpServerState,
} from '../../core/models';
import { CapabilityCatalogService } from '../../core/capability-catalog.service';
import { RECOMMENDED_MCP_SERVERS, RecommendedMcpServer } from '../../core/recommendations';
import { FolderList } from './folder-list';
import { MarketplaceRegistryService } from './marketplace-registry.service';
import { McpInstallDialog, McpInstallDraft, suggestServerName } from './mcp-install-dialog';
import { SettingsDraftService } from './settings-draft.service';
import { Toggle } from '../toggle';

import { TypedInput } from '../typed-input';

@Component({
  selector: 'app-mcp-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MarketplaceRegistryService],
  imports: [TypedInput, TranslocoPipe, FolderList, Toggle, McpInstallDialog],
  template: `
    <div
      class="mb-6 inline-flex rounded-full border border-white/10 bg-ink/40 p-0.5"
      role="tablist"
    >
      <button
        type="button"
        role="tab"
        [attr.aria-selected]="tab() === 'browse'"
        [class]="tabClass(tab() === 'browse')"
        (click)="tab.set('browse')"
      >
        {{ 'settings.mcp.tabBrowse' | transloco }}
      </button>
      <button
        type="button"
        role="tab"
        [attr.aria-selected]="tab() === 'configured'"
        [class]="tabClass(tab() === 'configured')"
        (click)="tab.set('configured')"
      >
        {{ 'settings.mcp.tabConfigured' | transloco }}
        <span class="ml-1 opacity-60">{{ enabledCount() }}</span>
      </button>
    </div>

    @if (tab() === 'browse') {
      <section>
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 class="text-sm font-semibold text-white">
              {{ 'settings.mcp.directory.title' | transloco }}
            </h3>
            <p class="mt-1 text-xs leading-relaxed text-mist/30">
              {{ 'settings.mcp.directory.subtitle' | transloco: { count: directoryTotal() } }}
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-full border border-white/15 px-3.5 py-1.5 text-xs text-mist transition-colors hover:bg-white/5"
            (click)="loadDirectory(true)"
          >
            ↻ {{ 'common.refresh' | transloco }}
          </button>
        </div>

        <input
          type="search"
          class="field mt-4 w-full rounded-xl px-4 py-2 text-sm"
          [value]="directoryQuery()"
          [placeholder]="'settings.mcp.directory.search' | transloco"
          (typedValue)="onDirectoryQuery($event)"
        />

        <div class="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            [class]="chipClass(directoryCategory() === null)"
            (click)="setDirectoryCategory(null)"
          >
            {{ 'settings.mcp.directory.all' | transloco }}
          </button>
          @for (category of directoryCategories; track category.id) {
            <button
              type="button"
              [class]="chipClass(directoryCategory() === category.id)"
              (click)="setDirectoryCategory(category.id)"
            >
              {{ 'settings.mcp.directory.categories.' + category.key | transloco }}
            </button>
          }
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <span class="text-xs text-mist/40">{{
            'settings.mcp.directory.source' | transloco
          }}</span>
          @for (item of directorySources; track item.id) {
            <button
              type="button"
              [class]="chipClass(directorySource() === item.id)"
              (click)="setDirectorySource(item.id)"
            >
              {{ sourceLabelKey(item.id) | transloco }}
              @if (directoryCounts()?.[item.id]; as count) {
                ({{ count }})
              }
            </button>
          }
          <select
            class="field field-select ml-auto w-44 rounded-xl py-1.5 pr-9 pl-3 text-xs"
            [value]="directorySort()"
            (typedValue)="onDirectorySort($event)"
          >
            @for (option of directorySortOptions; track option.id) {
              <option [value]="option.id">
                {{ 'settings.mcp.directory.' + option.key | transloco }}
              </option>
            }
          </select>
        </div>

        <p class="mt-1 text-xs leading-relaxed text-mist/30">
          {{ 'settings.mcp.directory.installHint' | transloco }}
        </p>

        @if (registry.error()) {
          <p class="mt-3 text-sm text-red-400">{{ registry.error() }}</p>
        }

        @if (directoryLoading()) {
          <p class="mt-4 text-sm text-mist/30">{{ 'common.loading' | transloco }}</p>
        } @else {
          <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            @for (server of directoryServers(); track server.name) {
              <div class="flex flex-col rounded-xl border border-white/10 bg-ink/40 p-4">
                <div class="flex items-start gap-2.5">
                  <span
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-sm font-semibold text-accent"
                  >
                    {{ initial(server) }}
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium text-mist">{{ server.displayName }}</p>
                    <div class="mt-1 flex flex-wrap items-center gap-1.5">
                      @if (server.sourceRegistry === 'official-mcp') {
                        <span
                          class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300"
                          [attr.title]="'settings.mcp.directory.officialTooltip' | transloco"
                        >
                          {{ 'settings.mcp.directory.official' | transloco }}
                        </span>
                      } @else if (server.sourceRegistry === 'docker') {
                        <span
                          class="rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300"
                          [attr.title]="'settings.mcp.directory.dockerTooltip' | transloco"
                        >
                          {{ 'settings.mcp.directory.docker' | transloco }}
                        </span>
                      }
                      @if (isInstalled(suggestName(server.name))) {
                        <span
                          class="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
                        >
                          ✓ {{ 'settings.mcp.installed' | transloco }}
                        </span>
                      }
                    </div>
                  </div>
                  @if (directoryMetric(server); as metric) {
                    <span
                      class="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-xs text-mist/60"
                    >
                      {{ metric.icon }} {{ formatCount(metric.value) }}
                    </span>
                  }
                </div>

                @if (server.description) {
                  <p class="mt-2 line-clamp-3 text-xs leading-relaxed text-mist/50">
                    {{ server.description }}
                  </p>
                }

                <div class="mt-auto flex items-center gap-2 pt-3">
                  <button
                    type="button"
                    [class]="
                      isInstalled(suggestName(server.name))
                        ? 'rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5'
                        : 'rounded-full bg-accent px-3 py-1 text-xs font-medium text-ink transition-opacity hover:opacity-90'
                    "
                    (click)="installDirectory(server)"
                  >
                    {{
                      (isInstalled(suggestName(server.name))
                        ? 'settings.mcp.reinstall'
                        : 'settings.mcp.directory.install'
                      ) | transloco
                    }}
                  </button>
                  @if (directoryLink(server); as link) {
                    <button
                      type="button"
                      class="rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5"
                      (click)="openDirectoryLink(link)"
                    >
                      {{ 'settings.mcp.directory.github' | transloco }}
                    </button>
                  }
                </div>
              </div>
            } @empty {
              @if (!directoryLoading()) {
                <p class="text-sm text-mist/30">{{ 'settings.mcp.directory.empty' | transloco }}</p>
              }
            }
          </div>

          @if (directoryHasMore()) {
            <button
              type="button"
              class="mt-3 w-full rounded-xl border border-white/15 px-4 py-2 text-xs text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
              [disabled]="directoryLoadingMore()"
              (click)="loadDirectory(false)"
            >
              {{ 'settings.mcp.directory.loadMore' | transloco }}
            </button>
          }
        }
      </section>

      <section class="mt-8">
        <h3 class="text-sm font-semibold text-white">{{ 'settings.mcp.registry' | transloco }}</h3>
        <p class="mb-3 mt-1 text-xs leading-relaxed text-mist/30">
          {{ 'settings.mcp.registryHint' | transloco }}
        </p>

        <h4 class="mb-1 text-xs font-semibold uppercase tracking-wide text-mist/40">
          {{ 'settings.mcp.recommended' | transloco }}
        </h4>
        <p class="mb-2 text-xs leading-relaxed text-mist/30">
          {{ 'settings.mcp.recommendedHint' | transloco }}
        </p>
        <div class="mb-3 flex flex-wrap gap-1.5">
          @for (item of recommended; track item.query) {
            <button
              type="button"
              class="rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
              [disabled]="searching()"
              [title]="item.descriptionKey | transloco"
              (click)="searchRecommended(item)"
            >
              {{ item.nameKey | transloco }}
            </button>
          }
        </div>

        <div class="flex gap-2">
          <input
            type="search"
            class="field min-w-0 flex-1 rounded-xl px-4 py-2 text-sm"
            [value]="searchQuery()"
            [placeholder]="'settings.mcp.registrySearch' | transloco"
            (typedValue)="searchQuery.set($event)"
            (keydown.enter)="search()"
          />
          <button
            type="button"
            class="shrink-0 rounded-xl border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
            [disabled]="searching()"
            (click)="search()"
          >
            {{ 'common.search' | transloco }}
          </button>
        </div>

        <div class="mt-3 flex items-center gap-3">
          <app-toggle
            size="sm"
            [checked]="draft.draft().marketplaceVerifiedOnly"
            (toggled)="toggleVerifiedOnly()"
          />
          <span class="text-xs text-mist/50">{{ 'settings.mcp.verifiedOnly' | transloco }}</span>
        </div>
        <p class="mt-1 text-xs leading-relaxed text-mist/30">
          {{ 'settings.mcp.verifiedOnlyHint' | transloco }}
        </p>

        @if (registry.error()) {
          <p class="mt-3 text-sm text-red-400">{{ registry.error() }}</p>
        }

        @if (searching()) {
          <p class="mt-3 text-sm text-mist/30">{{ 'common.loading' | transloco }}</p>
        }

        <div class="mt-3 space-y-1.5">
          @for (server of results(); track server.name) {
            <div class="rounded-xl border border-white/10 bg-ink/40 px-4 py-3">
              <div class="flex items-center gap-2">
                @if (server.verified) {
                  <span
                    class="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300"
                    [attr.title]="'settings.mcp.verifiedTooltip' | transloco"
                  >
                    {{ 'settings.mcp.verified' | transloco }}
                  </span>
                }
                <span class="truncate text-sm text-mist">{{ server.title || server.name }}</span>
                @if (server.version) {
                  <span class="shrink-0 text-xs text-mist/30">v{{ server.version }}</span>
                }
              </div>
              <p class="mt-0.5 truncate font-mono text-xs text-mist/30">{{ server.name }}</p>
              @if (server.description) {
                <p class="mt-1 text-xs leading-relaxed text-mist/50">{{ server.description }}</p>
              }
              <p class="mt-1 truncate font-mono text-xs text-mist/40">
                @if (server.command) {
                  {{ server.command }} {{ server.args.join(' ') }}
                } @else if (server.url) {
                  {{ server.transport || 'remote' }} · {{ server.url }}
                }
              </p>
              @if (server.env.length > 0) {
                <p class="mt-1 text-xs text-mist/40">
                  {{ 'settings.mcp.registryEnv' | transloco: { names: envNames(server) } }}
                </p>
              }
              <div class="mt-2 flex gap-2">
                @if (server.command || server.url) {
                  <button
                    type="button"
                    class="rounded-full bg-accent px-3 py-1 text-xs font-medium text-ink transition-opacity hover:opacity-90"
                    (click)="installRegistry(server)"
                  >
                    {{
                      (isInstalled(suggestName(server.name))
                        ? 'settings.mcp.reinstall'
                        : 'settings.mcp.directory.install'
                      ) | transloco
                    }}
                  </button>
                }
                <button
                  type="button"
                  class="rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5"
                  (click)="copyConfig(server)"
                >
                  {{
                    (copied() === server.name ? 'settings.mcp.copied' : 'common.copy') | transloco
                  }}
                </button>
                @if (server.repository) {
                  <button
                    type="button"
                    class="rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5"
                    (click)="openRepository(server.repository)"
                  >
                    {{ 'settings.mcp.repository' | transloco }}
                  </button>
                }
              </div>
            </div>
          } @empty {
            @if (!searching() && searched()) {
              <p class="text-sm text-mist/30">{{ 'settings.mcp.registryNoResults' | transloco }}</p>
            }
          }
        </div>
      </section>
    } @else {
      <section>
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.mcp.installedServers' | transloco }}
        </h3>
        <p class="mt-1 mb-3 text-xs leading-relaxed text-mist/30">
          {{ 'settings.mcp.installedServersHint' | transloco }}
        </p>
        <div class="space-y-1.5">
          @for (entry of installedServers(); track entry.server.name) {
            <div
              class="flex items-center gap-2.5 rounded-xl border border-white/10 bg-ink/40 px-4 py-3"
            >
              <app-toggle
                size="xs"
                [checked]="entry.server.enabled"
                [disabled]="!entry.candidate.enabled"
                (toggled)="toggleServer(entry.candidate, entry.server)"
              />
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-mist">{{ entry.server.name }}</p>
                @if (entry.server.detail) {
                  <p
                    class="truncate font-mono text-xs text-mist/30"
                    [attr.title]="entry.server.detail"
                  >
                    {{ entry.server.detail }}
                  </p>
                }
              </div>
              <button
                type="button"
                class="shrink-0 rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5 disabled:opacity-40"
                [disabled]="removingServer() === entry.server.name"
                (click)="uninstallServer(entry.server.name)"
              >
                {{ 'common.remove' | transloco }}
              </button>
            </div>
          } @empty {
            <div class="rounded-xl border border-dashed border-white/10 px-4 py-4 text-center">
              <p class="text-sm text-mist/40">
                {{ 'settings.mcp.noInstalledServers' | transloco }}
              </p>
              <button
                type="button"
                class="mt-2 rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5"
                (click)="tab.set('browse')"
              >
                {{ 'settings.mcp.tabBrowse' | transloco }}
              </button>
            </div>
          }
        </div>
      </section>

      <section class="mt-8 flex items-center justify-between gap-4">
        <div>
          <h3 class="text-sm font-semibold text-white">
            {{ 'settings.mcp.autoDiscovery' | transloco }}
          </h3>
          <p class="mt-1 text-xs leading-relaxed text-mist/30">
            {{ 'settings.mcp.autoDiscoveryHint' | transloco }}
          </p>
        </div>
        <button
          type="button"
          class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
          [class]="draft.draft().mcpAutoDiscovery ? 'bg-accent' : 'bg-white/15'"
          (click)="draft.patch('mcpAutoDiscovery', !draft.draft().mcpAutoDiscovery)"
        >
          <span
            class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
            [class]="draft.draft().mcpAutoDiscovery ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
          ></span>
        </button>
      </section>

      <section class="mt-8">
        <h3 class="mb-2 text-sm font-semibold text-white">
          {{ 'settings.mcp.folders' | transloco }}
        </h3>
        <p class="mb-3 text-xs leading-relaxed text-mist/30">
          {{ 'settings.mcp.foldersHint' | transloco }}
        </p>
        <app-folder-list
          [folders]="draft.draft().mcpFolders"
          (changed)="draft.patch('mcpFolders', $event)"
          addLabel="settings.mcp.addFolder"
        />
      </section>

      <section class="mt-8">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-sm font-semibold text-white">
            {{ 'settings.mcp.detected' | transloco }}
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
          @for (candidate of detectedCandidates(); track candidate.path) {
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
                <span class="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-xs text-mist/40">
                  {{ candidate.format }}
                </span>
              </div>
              <p class="mt-1 truncate font-mono text-xs text-mist/30">{{ candidate.path }}</p>
              @if (candidate.servers.length > 0) {
                <div class="mt-2 space-y-1.5">
                  @for (server of candidate.servers; track server.name) {
                    <div class="flex items-center gap-2.5">
                      <app-toggle
                        size="xs"
                        [checked]="server.enabled"
                        [disabled]="!candidate.enabled"
                        (toggled)="toggleServer(candidate, server)"
                      />
                      <span
                        [class]="
                          'shrink-0 text-xs ' +
                          (server.enabled ? 'text-mist' : 'text-mist/30 line-through')
                        "
                      >
                        {{ server.name }}
                      </span>
                      @if (server.detail) {
                        <span
                          class="min-w-0 truncate font-mono text-[11px] text-mist/25"
                          [attr.title]="server.detail"
                        >
                          {{ server.detail }}
                        </span>
                      }
                    </div>
                  }
                </div>
              } @else {
                <p class="mt-1 text-xs text-mist/20">{{ 'settings.mcp.noServers' | transloco }}</p>
              }
            </div>
          } @empty {
            @if (!loading()) {
              <p class="text-sm text-mist/30">{{ 'settings.mcp.noSources' | transloco }}</p>
            }
          }
        </div>

        <p class="mt-4 text-xs leading-relaxed text-mist/30">
          {{ 'settings.mcp.phaseNote' | transloco }}
        </p>
      </section>
    }

    @if (installDraft(); as draft) {
      <app-mcp-install-dialog
        [draft]="draft"
        [installedNames]="installedNames()"
        (installed)="onInstalled()"
        (closed)="installDraft.set(null)"
      />
    }
  `,
})
export class McpSettings {
  protected readonly draft = inject(SettingsDraftService);
  protected readonly registry = inject(MarketplaceRegistryService);
  private readonly transloco = inject(TranslocoService);
  private readonly catalog = inject(CapabilityCatalogService);
  protected readonly recommended = RECOMMENDED_MCP_SERVERS;
  protected readonly tab = signal<'browse' | 'configured'>('browse');
  protected readonly installDraft = signal<McpInstallDraft | null>(null);
  protected readonly installedNames = signal<string[]>([]);
  protected readonly removingServer = signal<string | null>(null);
  protected readonly candidates = signal<McpCandidate[]>([]);
  /** Servers in pumr's own config, shown with a Remove action. */
  protected readonly installedServers = computed(() =>
    this.candidates()
      .filter((candidate) => candidate.source === 'installed')
      .flatMap((candidate) => candidate.servers.map((server) => ({ candidate, server }))),
  );
  /** Config files found elsewhere (other tools, custom folders). */
  protected readonly detectedCandidates = computed(() =>
    this.candidates().filter((candidate) => candidate.source !== 'installed'),
  );
  protected readonly enabledCount = computed(
    () =>
      this.candidates().flatMap((candidate) => candidate.servers.filter((server) => server.enabled))
        .length,
  );
  protected readonly loading = signal(false);
  protected readonly searchQuery = signal('');
  protected readonly results = signal<MarketplaceServer[]>([]);
  protected readonly searching = signal(false);
  protected readonly searched = signal(false);
  protected readonly copied = signal<string | null>(null);

  protected readonly directoryServers = signal<DirectoryServer[]>([]);
  protected readonly directoryTotal = signal(0);
  protected readonly directoryHasMore = signal(false);
  protected readonly directoryLoading = signal(false);
  protected readonly directoryLoadingMore = signal(false);
  protected readonly directoryQuery = signal('');
  protected readonly directoryCategory = signal<string | null>(null);
  protected readonly directorySource = signal('all');
  protected readonly directorySort = signal('stars');
  protected readonly directoryCounts = signal<Record<string, number> | null>(null);

  protected readonly directoryCategories = [
    { id: 'web-search', key: 'webSearch' },
    { id: 'browser-automation', key: 'browserAutomation' },
    { id: 'blockchain-crypto', key: 'blockchainCrypto' },
    { id: 'ai-task-management', key: 'aiTaskManagement' },
    { id: 'developer-tools', key: 'developerTools' },
    { id: 'database', key: 'database' },
    { id: 'file-system', key: 'fileSystem' },
    { id: 'cloud-infrastructure', key: 'cloudInfrastructure' },
    { id: 'productivity', key: 'productivity' },
    { id: 'media-generation', key: 'mediaGeneration' },
    { id: 'utilities', key: 'utilities' },
  ];

  protected readonly directorySources = [{ id: 'all' }, { id: 'official-mcp' }, { id: 'docker' }];

  protected readonly directorySortOptions = [
    { id: 'stars', key: 'mostStars' },
    { id: 'downloads', key: 'mostDownloads' },
    { id: 'name', key: 'sortName' },
    { id: 'updated', key: 'recentlyUpdated' },
  ];

  private directorySearchTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly query = computed(() => {
    const draft = this.draft.draft();
    return JSON.stringify({
      folders: draft.mcpFolders,
      disabled: draft.mcpDisabled,
      disabledServers: draft.mcpDisabledServers,
      auto: draft.mcpAutoDiscovery,
    });
  });

  constructor() {
    effect(() => {
      this.query();
      void this.refresh();
    });
    void this.loadDirectory(true);
    void this.loadDirectoryCounts();
    void this.loadInstalledNames();
  }

  private async loadInstalledNames(): Promise<void> {
    try {
      this.installedNames.set(await api.listInstalledMcpServers());
    } catch {
      this.installedNames.set([]);
    }
  }

  protected suggestName(name: string): string {
    return suggestServerName(name);
  }

  protected isInstalled(name: string): boolean {
    return this.installedNames().includes(name);
  }

  protected tabClass(active: boolean): string {
    return active
      ? 'rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-ink'
      : 'rounded-full px-4 py-1.5 text-xs text-mist/60 transition-colors hover:text-mist';
  }

  protected async onInstalled(): Promise<void> {
    await Promise.all([this.loadInstalledNames(), this.refresh(), this.catalog.refresh()]);
  }

  protected async uninstallServer(name: string): Promise<void> {
    if (this.removingServer()) {
      return;
    }
    this.removingServer.set(name);
    this.registry.clearError();
    try {
      await api.uninstallMcpServer(name);
      await this.onInstalled();
    } catch (error) {
      this.registry.error.set(String(error));
    } finally {
      this.removingServer.set(null);
    }
  }

  protected installRegistry(server: MarketplaceServer): void {
    this.installDraft.set({
      name: suggestServerName(server.name),
      displayName: server.title || server.name,
      command: server.url ? null : server.command,
      args: server.url ? [] : server.args,
      url: server.url,
      transport: server.transport,
      env: server.env,
      requirements: [],
      cli: null,
    });
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const draft = this.draft.draft();
      this.candidates.set(
        await api.discoverMcpSources(
          draft.mcpFolders,
          draft.mcpDisabled,
          draft.mcpDisabledServers,
          draft.mcpAutoDiscovery,
        ),
      );
    } finally {
      this.loading.set(false);
    }
  }

  protected toggle(candidate: McpCandidate): void {
    const disabled = this.draft.draft().mcpDisabled;
    this.draft.patch(
      'mcpDisabled',
      candidate.enabled
        ? [...disabled, candidate.path]
        : disabled.filter((entry) => entry !== candidate.path),
    );
  }

  protected toggleServer(candidate: McpCandidate, server: McpServerState): void {
    if (!candidate.enabled) {
      return;
    }
    const disabled = this.draft.draft().mcpDisabledServers;
    const matches = (entry: { path: string; name: string }): boolean =>
      entry.path === candidate.path && entry.name === server.name;
    this.draft.patch(
      'mcpDisabledServers',
      disabled.some(matches)
        ? disabled.filter((entry) => !matches(entry))
        : [...disabled, { path: candidate.path, name: server.name }],
    );
  }

  protected async search(): Promise<void> {
    this.searching.set(true);
    try {
      this.results.set(
        await this.registry.searchMcp(
          this.searchQuery().trim() || null,
          !this.draft.draft().marketplaceVerifiedOnly,
        ),
      );
      this.searched.set(true);
    } finally {
      this.searching.set(false);
    }
  }

  protected async toggleVerifiedOnly(): Promise<void> {
    this.draft.patch('marketplaceVerifiedOnly', !this.draft.draft().marketplaceVerifiedOnly);
    await this.draft.save();
    if (this.searched()) {
      await this.search();
    }
  }

  protected searchRecommended(item: RecommendedMcpServer): void {
    this.searchQuery.set(item.query);
    void this.search();
  }

  protected envNames(server: MarketplaceServer): string {
    return server.env
      .map((variable) => `${variable.name}${variable.required ? ' *' : ''}`)
      .join(', ');
  }

  protected async copyConfig(server: MarketplaceServer): Promise<void> {
    const key = server.name.split('/').pop() || server.name;
    const entry: Record<string, unknown> = {};
    if (server.url) {
      entry['url'] = server.url;
    } else if (server.command) {
      entry['command'] = server.command;
      if (server.args.length > 0) {
        entry['args'] = server.args;
      }
    }
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ mcpServers: { [key]: entry } }, null, 2),
      );
      this.copied.set(server.name);
      setTimeout(() => this.copied.set(null), 1500);
    } catch {
      this.registry.error.set(this.transloco.translate('common.clipboardError'));
    }
  }

  protected openRepository(url: string): void {
    void api.openExternalUrl(url);
  }

  protected onDirectoryQuery(value: string): void {
    this.directoryQuery.set(value);
    if (this.directorySearchTimer) {
      clearTimeout(this.directorySearchTimer);
    }
    this.directorySearchTimer = setTimeout(() => void this.loadDirectory(true), 350);
  }

  protected setDirectoryCategory(id: string | null): void {
    this.directoryCategory.set(id);
    void this.loadDirectory(true);
  }

  protected setDirectorySource(id: string): void {
    if (this.directorySource() === id) {
      return;
    }
    this.directorySource.set(id);
    void this.loadDirectory(true);
  }

  protected onDirectorySort(value: string): void {
    this.directorySort.set(value);
    void this.loadDirectory(true);
  }

  protected async loadDirectory(reset: boolean): Promise<void> {
    if (reset) {
      this.directoryLoading.set(true);
    } else {
      this.directoryLoadingMore.set(true);
    }
    try {
      const page = await this.registry.browseDirectory({
        query: this.directoryQuery().trim() || null,
        category: this.directoryCategory(),
        source: this.directorySource(),
        sort: this.directorySort(),
        limit: 24,
        offset: reset ? 0 : this.directoryServers().length,
      });
      if (!page) {
        return;
      }
      this.directoryTotal.set(page.total);
      this.directoryHasMore.set(page.hasMore);
      this.directoryServers.update((servers) =>
        reset ? page.servers : [...servers, ...page.servers],
      );
    } finally {
      this.directoryLoading.set(false);
      this.directoryLoadingMore.set(false);
    }
  }

  private async loadDirectoryCounts(): Promise<void> {
    try {
      const [all, official, docker] = await Promise.all([
        api.browseMcpDirectory(null, null, 'all', 'stars', 1, 0),
        api.browseMcpDirectory(null, null, 'official-mcp', 'stars', 1, 0),
        api.browseMcpDirectory(null, null, 'docker', 'stars', 1, 0),
      ]);
      this.directoryCounts.set({
        all: all.total,
        'official-mcp': official.total,
        docker: docker.total,
      });
    } catch {}
  }

  protected chipClass(active: boolean): string {
    return active
      ? 'rounded-full bg-accent px-3 py-1 text-xs font-medium text-ink'
      : 'rounded-full border border-white/15 px-3 py-1 text-xs text-mist/60 transition-colors hover:bg-white/5';
  }

  protected sourceLabelKey(id: string): string {
    if (id === 'official-mcp') {
      return 'settings.mcp.directory.official';
    }
    if (id === 'docker') {
      return 'settings.mcp.directory.docker';
    }
    return 'settings.mcp.directory.all';
  }

  protected initial(server: DirectoryServer): string {
    return (server.displayName || server.name).charAt(0).toUpperCase();
  }

  protected directoryMetric(server: DirectoryServer): { icon: string; value: number } | null {
    if (server.githubStars) {
      return { icon: '★', value: server.githubStars };
    }
    const downloads = server.dockerPulls || server.npmDownloads;
    return downloads ? { icon: '↓', value: downloads } : null;
  }

  protected formatCount(value: number): string {
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    }
    if (value >= 1_000) {
      return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    return String(value);
  }

  protected directoryLink(server: DirectoryServer): string | null {
    return server.githubUrl ?? server.documentationUrl ?? server.npmUrl ?? server.dockerUrl;
  }

  protected openDirectoryLink(url: string): void {
    void api.openExternalUrl(url);
  }

  protected installDirectory(server: DirectoryServer): void {
    const { install } = server;
    this.installDraft.set({
      name: suggestServerName(server.name),
      displayName: server.displayName || server.name,
      command: install.url ? null : install.command,
      args: install.url ? [] : install.args,
      url: install.url,
      transport: install.transport,
      env: server.env,
      requirements: install.requirements,
      cli: install.cli,
    });
  }
}
