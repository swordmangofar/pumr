import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { api } from '../../core/api';
import { McpCandidate } from '../../core/models';
import { FolderList } from './folder-list';
import { SettingsDraftService } from './settings-draft.service';

@Component({
  selector: 'app-mcp-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, FolderList],
  template: `
    <section class="flex items-center justify-between gap-4">
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
        <h3 class="text-sm font-semibold text-white">{{ 'settings.mcp.detected' | transloco }}</h3>
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
              <span class="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-xs text-mist/40">
                {{ candidate.format }}
              </span>
            </div>
            <p class="mt-1 truncate font-mono text-xs text-mist/30">{{ candidate.path }}</p>
            @if (candidate.servers.length > 0) {
              <div class="mt-2 flex flex-wrap gap-1.5">
                @for (server of candidate.servers; track server) {
                  <span
                    class="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs text-emerald-300"
                  >
                    {{ server }}
                  </span>
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
  `,
})
export class McpSettings {
  protected readonly draft = inject(SettingsDraftService);
  protected readonly candidates = signal<McpCandidate[]>([]);
  protected readonly loading = signal(false);

  private readonly query = computed(() => {
    const draft = this.draft.draft();
    return JSON.stringify({
      folders: draft.mcpFolders,
      disabled: draft.mcpDisabled,
      auto: draft.mcpAutoDiscovery,
    });
  });

  constructor() {
    effect(() => {
      this.query();
      void this.refresh();
    });
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const draft = this.draft.draft();
      this.candidates.set(
        await api.discoverMcpSources(draft.mcpFolders, draft.mcpDisabled, draft.mcpAutoDiscovery),
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
}
