import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { api } from '../../core/api';
import { IgnoreCatalogEntry, PermissionDefaultAction, PermissionDefaults } from '../../core/models';
import { SettingsService } from '../../core/settings.service';
import { SettingsDraftService } from './settings-draft.service';
import { Toggle } from '../toggle';

type FileToggleKey =
  'ignoreGitignored' | 'scanGeneratedFiles' | 'ignoreLocalDatabases' | 'ignoreEnvFiles';

interface CatalogGroup {
  key: string;
  labelKey: string;
  master: FileToggleKey | null;
  invert?: boolean;
}

const CATALOG_GROUPS: readonly CatalogGroup[] = [
  {
    key: 'generatedFolders',
    labelKey: 'settings.ignoreGroups.generatedFolders',
    master: 'scanGeneratedFiles',
    invert: true,
  },
  {
    key: 'generatedFiles',
    labelKey: 'settings.ignoreGroups.generatedFiles',
    master: 'scanGeneratedFiles',
    invert: true,
  },
  {
    key: 'databases',
    labelKey: 'settings.ignoreGroups.databases',
    master: 'ignoreLocalDatabases',
  },
  {
    key: 'environment',
    labelKey: 'settings.ignoreGroups.environment',
    master: 'ignoreEnvFiles',
  },
  {
    key: 'credentials',
    labelKey: 'settings.ignoreGroups.credentials',
    master: null,
  },
];

import { TypedInput } from '../typed-input';

@Component({
  selector: 'app-agent-rules-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe, Toggle],
  template: `
    <section>
      <div class="mb-1 flex items-center justify-between gap-3">
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.fileAccessRules' | transloco }}
        </h3>
        <label class="flex cursor-pointer items-center gap-2 text-xs text-mist/50">
          {{ 'settings.advancedMode' | transloco }}
          <app-toggle
            size="sm"
            [checked]="draft.draft().fileIgnoreAdvanced"
            (toggled)="toggleAdvanced()"
          />
        </label>
      </div>
      <p class="mb-4 text-xs text-mist/30">{{ 'settings.fileAccessRulesHint' | transloco }}</p>

      <div class="space-y-3">
        <div class="rounded-xl border border-white/10 bg-ink/40 px-4 py-3">
          <div class="flex items-start gap-3">
            <app-toggle
              class="mt-0.5"
              [checked]="isOn('ignoreGitignored')"
              (toggled)="toggle('ignoreGitignored')"
            />
            <div>
              <label class="block text-sm font-medium text-mist">
                {{ 'settings.ignoreGitignored' | transloco }}
              </label>
              <p class="mt-1 text-xs leading-relaxed text-mist/30">
                {{ 'settings.ignoreGitignoredHint' | transloco }}
              </p>
            </div>
          </div>

          @if (isOn('ignoreGitignored')) {
            <div class="mt-3 flex items-start gap-3 border-l border-white/10 pl-4">
              <app-toggle
                class="mt-0.5"
                [checked]="isOn('scanGeneratedFiles')"
                (toggled)="toggle('scanGeneratedFiles')"
              />
              <div>
                <label class="block text-sm text-mist">
                  {{ 'settings.scanGeneratedFiles' | transloco }}
                </label>
                <p class="mt-1 text-xs leading-relaxed text-mist/30">
                  {{ 'settings.scanGeneratedFilesHint' | transloco }}
                </p>
              </div>
            </div>
          }
        </div>

        <div class="rounded-xl border border-white/10 bg-ink/40 px-4 py-3">
          <div class="flex items-start gap-3">
            <app-toggle
              class="mt-0.5"
              [checked]="isOn('ignoreLocalDatabases')"
              (toggled)="toggle('ignoreLocalDatabases')"
            />
            <div>
              <label class="block text-sm font-medium text-mist">
                {{ 'settings.ignoreLocalDatabases' | transloco }}
              </label>
              <p class="mt-1 text-xs leading-relaxed text-mist/30">
                {{ 'settings.ignoreLocalDatabasesHint' | transloco }}
              </p>
            </div>
          </div>
        </div>

        <div class="rounded-xl border border-white/10 bg-ink/40 px-4 py-3">
          <div class="flex items-start gap-3">
            <app-toggle
              class="mt-0.5"
              [checked]="isOn('ignoreEnvFiles')"
              (toggled)="toggle('ignoreEnvFiles')"
            />
            <div>
              <label class="block text-sm font-medium text-mist">
                {{ 'settings.ignoreEnvFiles' | transloco }}
              </label>
              <p class="mt-1 text-xs leading-relaxed text-mist/30">
                {{ 'settings.ignoreEnvFilesHint' | transloco }}
              </p>
            </div>
          </div>
          @if (!isOn('ignoreEnvFiles')) {
            <p
              class="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-200"
            >
              {{ 'settings.ignoreEnvFilesWarning' | transloco }}
            </p>
          }
        </div>
      </div>

      @if (draft.draft().fileIgnoreAdvanced) {
        <div class="mt-5 rounded-xl border border-white/10 bg-ink/40 px-4 py-3">
          <p class="text-xs leading-relaxed text-mist/40">
            {{ 'settings.advancedIgnoreHint' | transloco }}
          </p>
          @for (group of catalogGroups; track group.key) {
            <div class="mt-4">
              <div class="mb-2 flex items-center justify-between gap-3">
                <h4 class="text-xs font-semibold uppercase tracking-wide text-mist/60">
                  {{ group.labelKey | transloco }}
                </h4>
                @if (group.master) {
                  <app-toggle
                    size="sm"
                    [checked]="groupActive(group.key)"
                    (toggled)="toggleGroup(group.key)"
                  />
                }
              </div>
              <div class="grid grid-cols-2 gap-1.5">
                @for (entry of catalogFor(group.key); track entry.id) {
                  <div
                    class="flex items-center justify-between gap-2 rounded-lg border border-white/10 px-3 py-1.5"
                  >
                    <code class="truncate font-mono text-xs text-mist/70">{{ entry.pattern }}</code>
                    <app-toggle
                      size="xs"
                      [checked]="isRuleOn(entry)"
                      (toggled)="toggleRule(entry)"
                    />
                  </div>
                }
              </div>
            </div>
          }
        </div>
      }
    </section>

    <section class="mt-8">
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.fileIgnoreExemptions' | transloco }}
      </h3>
      <div class="space-y-1.5">
        @for (rule of fileIgnoreExemptions(); track rule) {
          <div
            class="flex items-center justify-between rounded-xl border border-white/10 bg-ink/40 px-4 py-2"
          >
            <code class="font-mono text-sm text-emerald-300">{{ rule }}</code>
            <button
              type="button"
              class="text-mist/40 transition-colors hover:text-rose-400"
              (click)="deleteExemption(rule)"
            >
              ✕
            </button>
          </div>
        } @empty {
          <p class="text-sm text-mist/30">{{ 'settings.noFileIgnoreExemptions' | transloco }}</p>
        }
      </div>
      <div class="mt-3 flex gap-2">
        <input
          class="field min-w-0 flex-1 rounded-xl px-4 py-2 font-mono text-sm"
          [placeholder]="'settings.fileIgnoreExemptionPlaceholder' | transloco"
          [value]="newExemption()"
          (typedValue)="newExemption.set($event)"
          (keydown.enter)="addExemption()"
        />
        <button
          type="button"
          class="rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5"
          (click)="addExemption()"
        >
          {{ 'settings.addExemption' | transloco }}
        </button>
      </div>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.fileIgnoreExemptionsHint' | transloco }}</p>
    </section>

    <section class="mt-8">
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.commandRules' | transloco }}
      </h3>
      <p class="mb-3 text-xs text-mist/30">{{ 'settings.commandRulesHint' | transloco }}</p>

      <h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-300/80">
        {{ 'settings.commandAllowlist' | transloco }} · {{ commandRules().length }}
      </h4>
      <div class="space-y-1.5">
        @for (rule of commandRules(); track rule) {
          <div
            class="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-ink/40 px-4 py-2"
          >
            <div class="flex min-w-0 items-center gap-2">
              <code class="truncate font-mono text-sm text-emerald-300">{{ rule }}</code>
              <span
                class="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-mist/40"
              >
                {{ scopeLabel(rule) | transloco }}
              </span>
            </div>
            <button
              type="button"
              class="text-mist/40 transition-colors hover:text-rose-400"
              (click)="deleteRule(rule, true)"
            >
              ✕
            </button>
          </div>
        } @empty {
          <p class="text-sm text-mist/30">{{ 'settings.noCommandRules' | transloco }}</p>
        }
      </div>

      <h4 class="mt-4 mb-1.5 text-xs font-semibold uppercase tracking-wide text-rose-300/80">
        {{ 'settings.commandDenylist' | transloco }} · {{ deniedCommandRules().length }}
      </h4>
      <div class="space-y-1.5">
        @for (rule of deniedCommandRules(); track rule) {
          <div
            class="flex items-center justify-between gap-3 rounded-xl border border-rose-500/20 bg-ink/40 px-4 py-2"
          >
            <div class="flex min-w-0 items-center gap-2">
              <code class="truncate font-mono text-sm text-rose-300">{{ rule }}</code>
              <span
                class="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-mist/40"
              >
                {{ scopeLabel(rule) | transloco }}
              </span>
            </div>
            <button
              type="button"
              class="text-mist/40 transition-colors hover:text-rose-400"
              (click)="deleteRule(rule, false)"
            >
              ✕
            </button>
          </div>
        } @empty {
          <p class="text-sm text-mist/30">{{ 'settings.noDeniedCommandRules' | transloco }}</p>
        }
      </div>

      <div class="mt-3 flex gap-2">
        <input
          class="field min-w-0 flex-1 rounded-xl px-4 py-2 font-mono text-sm"
          [placeholder]="'settings.rulePlaceholder' | transloco"
          [value]="newRule()"
          (typedValue)="newRule.set($event)"
          (keydown.enter)="addRule(true)"
        />
        <button
          type="button"
          class="rounded-full border border-emerald-500/30 px-4 py-2 text-sm text-emerald-300 transition-colors hover:bg-emerald-500/10"
          (click)="addRule(true)"
        >
          {{ 'settings.allowCommand' | transloco }}
        </button>
        <button
          type="button"
          class="rounded-full border border-rose-500/30 px-4 py-2 text-sm text-rose-300 transition-colors hover:bg-rose-500/10"
          (click)="addRule(false)"
        >
          {{ 'settings.denyCommand' | transloco }}
        </button>
      </div>
    </section>

    <section class="mt-8">
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.websiteRules' | transloco }}
      </h3>
      <p class="mb-3 text-xs text-mist/30">{{ 'settings.websiteRulesHint' | transloco }}</p>

      <h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-300/80">
        {{ 'settings.websiteAllowlist' | transloco }} · {{ allowedWebsites().length }}
      </h4>
      <div class="space-y-1.5">
        @for (rule of allowedWebsites(); track rule) {
          <div
            class="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-ink/40 px-4 py-2"
          >
            <div class="flex min-w-0 items-center gap-2">
              <code class="truncate font-mono text-sm text-emerald-300">{{ rule }}</code>
              <span
                class="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-mist/40"
              >
                {{ websiteLabel(rule) | transloco }}
              </span>
            </div>
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

      <h4 class="mt-4 mb-1.5 text-xs font-semibold uppercase tracking-wide text-rose-300/80">
        {{ 'settings.websiteDenylist' | transloco }} · {{ deniedWebsites().length }}
      </h4>
      <div class="mt-1 space-y-1.5">
        @for (rule of deniedWebsites(); track rule) {
          <div
            class="flex items-center justify-between gap-3 rounded-xl border border-rose-500/20 bg-ink/40 px-4 py-2"
          >
            <div class="flex min-w-0 items-center gap-2">
              <code class="truncate font-mono text-sm text-rose-300">{{ rule }}</code>
              <span
                class="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-mist/40"
              >
                {{ websiteLabel(rule) | transloco }}
              </span>
            </div>
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
          class="field min-w-0 flex-1 rounded-xl px-4 py-2 font-mono text-sm"
          [placeholder]="'settings.websitePlaceholder' | transloco"
          [value]="newWebsite()"
          (typedValue)="newWebsite.set($event)"
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
    </section>

    <section class="mt-8">
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.permissionPrompts' | transloco }}
      </h3>
      <p class="mb-3 text-xs text-mist/30">{{ 'settings.permissionPromptsHint' | transloco }}</p>
      <div class="space-y-1.5">
        @for (row of permissionRows; track row.key) {
          <div
            class="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-ink/40 px-4 py-2"
          >
            <span class="text-sm text-mist">{{ row.labelKey | transloco }}</span>
            <div class="flex rounded-full border border-white/10 p-0.5">
              <button
                type="button"
                class="rounded-full px-3 py-1 text-xs transition-colors"
                [class]="
                  draft.draft().permissionDefaults[row.key] === 'once'
                    ? 'bg-accent font-medium text-ink'
                    : 'text-mist/60 hover:text-mist'
                "
                (click)="setPermissionDefault(row.key, 'once')"
              >
                {{ 'permission.allowOnce' | transloco }}
              </button>
              <button
                type="button"
                class="rounded-full px-3 py-1 text-xs transition-colors"
                [class]="
                  draft.draft().permissionDefaults[row.key] === 'session'
                    ? 'bg-accent font-medium text-ink'
                    : 'text-mist/60 hover:text-mist'
                "
                (click)="setPermissionDefault(row.key, 'session')"
              >
                {{ 'permission.allowSession' | transloco }}
              </button>
            </div>
          </div>
        }
      </div>
    </section>
  `,
})
export class AgentRulesSettings {
  private readonly settingsService = inject(SettingsService);
  protected readonly draft = inject(SettingsDraftService);

  protected readonly newExemption = signal('');
  protected readonly fileIgnoreExemptions = computed(
    () => this.draft.draft().fileIgnoreExemptions,
  );

  protected isOn(key: FileToggleKey): boolean {
    return this.draft.draft()[key];
  }

  protected toggle(key: FileToggleKey): void {
    this.draft.patch(key, !this.draft.draft()[key]);
  }

  protected readonly catalogGroups = CATALOG_GROUPS;
  protected readonly catalog = signal<IgnoreCatalogEntry[]>([]);

  constructor() {
    void this.loadCatalog();
  }

  private async loadCatalog(): Promise<void> {
    try {
      this.catalog.set(await api.getFileIgnoreCatalog());
    } catch {
      this.catalog.set([]);
    }
  }

  protected catalogFor(group: string): IgnoreCatalogEntry[] {
    return this.catalog().filter((entry) => entry.group === group);
  }

  protected toggleAdvanced(): void {
    this.draft.patch('fileIgnoreAdvanced', !this.draft.draft().fileIgnoreAdvanced);
  }

  private baseOn(group: string): boolean {
    switch (group) {
      case 'generatedFolders':
      case 'generatedFiles':
        return !this.draft.draft().scanGeneratedFiles;
      case 'databases':
        return this.draft.draft().ignoreLocalDatabases;
      case 'environment':
        return this.draft.draft().ignoreEnvFiles;
      default:
        return true;
    }
  }

  protected isRuleOn(entry: IgnoreCatalogEntry): boolean {
    if (this.draft.draft().fileIgnoreDisabled.includes(entry.id)) {
      return false;
    }
    if (this.draft.draft().fileIgnoreEnabled.includes(entry.id)) {
      return true;
    }
    return this.baseOn(entry.group);
  }

  protected toggleRule(entry: IgnoreCatalogEntry): void {
    const disabled = new Set(this.draft.draft().fileIgnoreDisabled);
    const enabled = new Set(this.draft.draft().fileIgnoreEnabled);
    if (this.isRuleOn(entry)) {
      enabled.delete(entry.id);
      disabled.add(entry.id);
    } else {
      disabled.delete(entry.id);
      enabled.add(entry.id);
    }
    this.draft.patch('fileIgnoreDisabled', [...disabled]);
    this.draft.patch('fileIgnoreEnabled', [...enabled]);
  }

  protected groupActive(groupKey: string): boolean {
    const group = CATALOG_GROUPS.find((entry) => entry.key === groupKey);
    if (!group?.master) {
      return true;
    }
    return group.invert ? !this.isOn(group.master) : this.isOn(group.master);
  }

  protected toggleGroup(groupKey: string): void {
    const group = CATALOG_GROUPS.find((entry) => entry.key === groupKey);
    if (group?.master) {
      this.toggle(group.master);
    }
  }

  protected addExemption(): void {
    const value = this.newExemption().trim();
    if (!value) {
      return;
    }
    const current = this.draft.draft().fileIgnoreExemptions;
    if (!current.includes(value)) {
      this.draft.patch('fileIgnoreExemptions', [...current, value]);
    }
    this.newExemption.set('');
  }

  protected deleteExemption(value: string): void {
    this.draft.patch(
      'fileIgnoreExemptions',
      this.draft.draft().fileIgnoreExemptions.filter((entry) => entry !== value),
    );
  }

  protected readonly newRule = signal('');
  protected readonly commandRules = computed(
    () => this.settingsService.settings()?.commandRules ?? [],
  );
  protected readonly deniedCommandRules = computed(
    () => this.settingsService.settings()?.deniedCommandRules ?? [],
  );
  protected readonly newWebsite = signal('');
  protected readonly allowedWebsites = computed(
    () => this.settingsService.settings()?.allowedWebsites ?? [],
  );
  protected readonly deniedWebsites = computed(
    () => this.settingsService.settings()?.deniedWebsites ?? [],
  );

  protected readonly permissionRows: ReadonlyArray<{
    key: keyof PermissionDefaults;
    labelKey: string;
  }> = [
    { key: 'website', labelKey: 'permission.kind.web' },
    { key: 'command', labelKey: 'permission.kind.command' },
    { key: 'folder', labelKey: 'permission.kind.folder' },
  ];

  protected setPermissionDefault(
    key: keyof PermissionDefaults,
    value: PermissionDefaultAction,
  ): void {
    this.draft.patch('permissionDefaults', {
      ...this.draft.draft().permissionDefaults,
      [key]: value,
    });
  }

  protected scopeLabel(rule: string): string {
    if (rule.endsWith(' *')) {
      const body = rule.slice(0, -2).trim();
      return body.includes(' ') ? 'settings.scope.programFlags' : 'settings.scope.program';
    }
    return 'settings.scope.exact';
  }

  protected websiteLabel(rule: string): string {
    return rule.includes('*') ? 'settings.websiteScope.glob' : 'settings.websiteScope.domain';
  }

  protected async addRule(allow: boolean): Promise<void> {
    const rule = this.newRule().trim();
    if (!rule) {
      return;
    }
    await this.settingsService.addCommandRule(rule, allow);
    this.newRule.set('');
  }

  protected async deleteRule(rule: string, allow: boolean): Promise<void> {
    await this.settingsService.deleteCommandRule(rule, allow);
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
