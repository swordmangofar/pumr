import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { api } from '../core/api';
import { Mode, Settings } from '../core/models';
import { SettingsService } from '../core/settings.service';

import { TypedInput } from './typed-input';

@Component({
  selector: 'app-modes-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <div class="min-h-0 flex-1 overflow-y-auto">
      <section class="border-b border-white/5 p-4">
        <h3 class="mb-1 text-xs font-semibold uppercase tracking-widest text-mist/40">
          {{ 'right.modes' | transloco }}
        </h3>
        <p class="mb-3 text-xs leading-relaxed text-mist/30">
          {{ 'right.modesHint' | transloco }}
        </p>

        <label class="flex items-center justify-between gap-3">
          <span class="text-sm text-mist/60">{{ 'right.defaultMode' | transloco }}</span>
          <select
            class="field field-select max-w-44 truncate rounded-lg py-1.5 pr-8 pl-3 text-sm"
            [value]="defaultModeId()"
            (typedValue)="setDefaultMode($event)"
          >
            @for (mode of modes(); track mode.id) {
              <option [value]="mode.id">{{ mode.name }}</option>
            }
          </select>
        </label>

        <button
          type="button"
          class="mt-3 rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:border-accent/50 hover:text-white"
          (click)="addMode()"
        >
          + {{ 'right.addMode' | transloco }}
        </button>
      </section>

      <section class="space-y-2 p-4">
        @for (mode of modes(); track mode.id) {
          <div class="glass-inset rounded-xl">
            <div class="flex items-center gap-2.5 px-3 py-2">
              <button
                type="button"
                class="min-w-0 flex-1 truncate text-left text-sm text-mist"
                (click)="toggleExpanded(mode.id)"
              >
                {{ mode.name }}
              </button>
              @if (mode.planOnly) {
                <span
                  class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent"
                >
                  {{ 'right.planOnly' | transloco }}
                </span>
              }
              @if (defaultModeId() === mode.id) {
                <span class="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-mist/40">
                  {{ 'right.default' | transloco }}
                </span>
              }
              @if (mode.builtin) {
                <span class="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-mist/40">
                  {{ 'right.builtin' | transloco }}
                </span>
              }
              <span class="shrink-0 text-mist/30">{{ expanded(mode.id) ? '▾' : '▸' }}</span>
            </div>

            @if (mode.description && !expanded(mode.id)) {
              <p class="px-3 pb-2 text-xs leading-relaxed text-mist/40">{{ mode.description }}</p>
            }

            @if (expanded(mode.id)) {
              <div class="space-y-3 border-t border-white/5 p-3">
                <input
                  class="field w-full rounded-lg px-3 py-1.5 text-sm"
                  [placeholder]="'right.modeName' | transloco"
                  [value]="mode.name"
                  (typedValue)="renameMode(mode, $event)"
                />

                <div>
                  <label class="mb-1 block text-[10px] uppercase tracking-wide text-mist/40">
                    {{ 'right.modeDescription' | transloco }}
                  </label>
                  <input
                    class="field w-full rounded-lg px-3 py-1.5 text-sm"
                    [value]="mode.description"
                    (typedValue)="updateMode(mode.id, { description: $event })"
                  />
                </div>

                <div>
                  <label class="mb-1 block text-[10px] uppercase tracking-wide text-mist/40">
                    {{ 'right.modeSystemPrompt' | transloco }}
                  </label>
                  <textarea
                    class="field h-28 w-full resize-y rounded-lg px-3 py-2 font-mono text-xs leading-relaxed"
                    [value]="mode.systemPrompt"
                    (typedValue)="updateMode(mode.id, { systemPrompt: $event })"
                  ></textarea>
                </div>

                <div class="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    class="rounded-full border px-2.5 py-1 text-[11px] transition-colors"
                    [class]="
                      mode.includeGlobalPrompts
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-white/10 text-mist/40 hover:text-mist'
                    "
                    (click)="
                      updateMode(mode.id, { includeGlobalPrompts: !mode.includeGlobalPrompts })
                    "
                  >
                    {{ 'right.includeGlobalPrompts' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="rounded-full border px-2.5 py-1 text-[11px] transition-colors"
                    [class]="
                      mode.includeProjectRules
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-white/10 text-mist/40 hover:text-mist'
                    "
                    (click)="
                      updateMode(mode.id, { includeProjectRules: !mode.includeProjectRules })
                    "
                  >
                    {{ 'right.includeProjectRules' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="rounded-full border px-2.5 py-1 text-[11px] transition-colors"
                    [class]="
                      mode.planOnly
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-white/10 text-mist/40 hover:text-mist'
                    "
                    (click)="updateMode(mode.id, { planOnly: !mode.planOnly })"
                  >
                    {{ 'right.planOnly' | transloco }}
                  </button>
                </div>

                <div>
                  <span class="mb-1 block text-[10px] uppercase tracking-wide text-mist/40">
                    {{ 'right.modePrompts' | transloco }}
                  </span>
                  <div class="flex flex-wrap gap-1.5">
                    @for (prompt of userPrompts(); track prompt.id) {
                      <button
                        type="button"
                        class="rounded-full border px-2.5 py-1 text-[11px] transition-colors"
                        [class]="
                          mode.userPromptIds.includes(prompt.id)
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-white/10 text-mist/40 hover:text-mist'
                        "
                        (click)="togglePrompt(mode, prompt.id)"
                      >
                        {{ prompt.name }}
                      </button>
                    } @empty {
                      <span class="text-xs text-mist/30">{{
                        'right.noUserPrompts' | transloco
                      }}</span>
                    }
                  </div>
                </div>

                <div>
                  <span class="mb-1 block text-[10px] uppercase tracking-wide text-mist/40">
                    {{ 'right.modeMcp' | transloco }}
                  </span>
                  <div class="flex flex-wrap gap-1.5">
                    @for (server of mcpServers(); track server) {
                      <button
                        type="button"
                        class="rounded-full border px-2.5 py-1 text-[11px] transition-colors"
                        [class]="
                          mode.mcpServers.includes(server)
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-white/10 text-mist/40 hover:text-mist'
                        "
                        (click)="toggleMcp(mode, server)"
                      >
                        {{ server }}
                      </button>
                    } @empty {
                      <span class="text-xs text-mist/30">{{
                        'right.noMcpServers' | transloco
                      }}</span>
                    }
                  </div>
                </div>

                <div>
                  <span class="mb-1 block text-[10px] uppercase tracking-wide text-mist/40">
                    {{ 'right.modeSkills' | transloco }}
                  </span>
                  <div class="flex flex-wrap gap-1.5">
                    @for (skill of skills(); track skill) {
                      <button
                        type="button"
                        class="rounded-full border px-2.5 py-1 text-[11px] transition-colors"
                        [class]="
                          mode.skills.includes(skill)
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-white/10 text-mist/40 hover:text-mist'
                        "
                        (click)="toggleSkill(mode, skill)"
                      >
                        {{ skill }}
                      </button>
                    } @empty {
                      <span class="text-xs text-mist/30">{{ 'right.noSkills' | transloco }}</span>
                    }
                  </div>
                </div>

                <div class="flex items-center justify-between">
                  @if (isBuiltin(mode)) {
                    <button
                      type="button"
                      class="text-xs text-mist/50 transition-colors hover:text-accent"
                      (click)="resetMode(mode)"
                    >
                      ↺ {{ 'right.resetMode' | transloco }}
                    </button>
                  } @else {
                    <span></span>
                  }
                  <button
                    type="button"
                    class="text-xs text-mist/50 transition-colors hover:text-rose-400"
                    (click)="removeMode(mode)"
                  >
                    {{ 'right.deleteMode' | transloco }}
                  </button>
                </div>
              </div>
            }
          </div>
        }
      </section>
    </div>
  `,
})
export class ModesPanel {
  protected readonly settings = inject(SettingsService);
  private readonly transloco = inject(TranslocoService);

  protected readonly expandedIds = signal<string[]>([]);
  protected readonly mcpServers = signal<string[]>([]);
  protected readonly skills = signal<string[]>([]);

  protected readonly modes = computed(() => this.settings.modes());
  protected readonly userPrompts = computed(
    () => this.settings.settings()?.userSystemPrompts ?? [],
  );
  protected readonly defaultModeId = computed(
    () => this.settings.settings()?.defaultModeId ?? 'coding',
  );

  private readonly discoveryQuery = computed(() => {
    const settings = this.settings.settings();
    if (!settings) {
      return '';
    }
    return JSON.stringify({
      mcpFolders: settings.mcpFolders,
      mcpDisabled: settings.mcpDisabled,
      mcpDisabledServers: settings.mcpDisabledServers,
      mcpAutoDiscovery: settings.mcpAutoDiscovery,
      skillFolders: settings.skillFolders,
      skillsDisabled: settings.skillsDisabled,
      skillsDisabledItems: settings.skillsDisabledItems,
      skillsAutoDiscovery: settings.skillsAutoDiscovery,
    });
  });

  constructor() {
    effect(() => {
      const query = this.discoveryQuery();
      if (query) {
        untracked(() => void this.loadOptions());
      }
    });
  }

  protected expanded(id: string): boolean {
    return this.expandedIds().includes(id);
  }

  protected toggleExpanded(id: string): void {
    this.expandedIds.update((ids) =>
      ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id],
    );
  }

  protected isBuiltin(mode: Mode): boolean {
    return mode.builtin || this.settings.originalModes().some((entry) => entry.id === mode.id);
  }

  protected async updateMode(id: string, changes: Partial<Mode>): Promise<void> {
    await this.settings.patch({
      modes: this.modes().map((mode) => (mode.id === id ? { ...mode, ...changes } : mode)),
    });
  }

  protected async renameMode(mode: Mode, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === mode.name) {
      return;
    }
    await this.updateMode(mode.id, { name: trimmed });
  }

  protected togglePrompt(mode: Mode, promptId: string): void {
    void this.updateMode(mode.id, { userPromptIds: toggle(mode.userPromptIds, promptId) });
  }

  protected toggleMcp(mode: Mode, server: string): void {
    void this.updateMode(mode.id, { mcpServers: toggle(mode.mcpServers, server) });
  }

  protected toggleSkill(mode: Mode, skill: string): void {
    void this.updateMode(mode.id, { skills: toggle(mode.skills, skill) });
  }

  protected async addMode(): Promise<void> {
    const id = `mode-${Date.now().toString(36)}`;
    const mode: Mode = {
      id,
      name: this.transloco.translate('right.customMode'),
      description: '',
      systemPrompt: '',
      userPromptIds: [],
      mcpServers: [],
      skills: [],
      includeGlobalPrompts: true,
      includeProjectRules: true,
      planOnly: false,
      builtin: false,
    };
    await this.settings.patch({ modes: [...this.modes(), mode] });
    this.toggleExpanded(id);
  }

  protected async removeMode(mode: Mode): Promise<void> {
    const modes = this.modes().filter((entry) => entry.id !== mode.id);
    const patch: Partial<Settings> = { modes };
    if (this.defaultModeId() === mode.id) {
      patch.defaultModeId = 'coding';
    }
    await this.settings.patch(patch);
  }

  protected async resetMode(mode: Mode): Promise<void> {
    const original = this.settings.originalModes().find((entry) => entry.id === mode.id);
    if (!original) {
      return;
    }
    await this.updateMode(mode.id, { ...original, id: mode.id });
  }

  protected async setDefaultMode(id: string): Promise<void> {
    await this.settings.patch({ defaultModeId: id });
  }

  private async loadOptions(): Promise<void> {
    const settings = this.settings.settings();
    if (!settings) {
      return;
    }
    try {
      const [mcp, skillCandidates] = await Promise.all([
        api.discoverMcpSources(
          settings.mcpFolders,
          settings.mcpDisabled,
          settings.mcpDisabledServers,
          settings.mcpAutoDiscovery,
        ),
        api.discoverSkills(
          settings.skillFolders,
          settings.skillsDisabled,
          settings.skillsDisabledItems,
          settings.skillsAutoDiscovery,
        ),
      ]);
      this.mcpServers.set(
        [
          ...new Set(
            mcp.flatMap((candidate) =>
              candidate.servers.filter((server) => server.enabled).map((server) => server.name),
            ),
          ),
        ].sort(),
      );
      this.skills.set(
        [
          ...new Set(
            skillCandidates.flatMap((candidate) =>
              candidate.skills.filter((skill) => skill.enabled).map((skill) => skill.name),
            ),
          ),
        ].sort(),
      );
    } catch {
      // Discovery is best effort; the panel still works without options.
    }
  }
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}
