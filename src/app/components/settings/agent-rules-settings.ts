import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { api } from '../../core/api';
import { IgnoreCatalogEntry } from '../../core/models';
import { SettingsService } from '../../core/settings.service';
import { SettingsDraftService } from './settings-draft.service';

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

@Component({
  selector: 'app-agent-rules-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <section>
      <div class="mb-1 flex items-center justify-between gap-3">
        <h3 class="text-sm font-semibold text-white">
          {{ 'settings.fileAccessRules' | transloco }}
        </h3>
        <label class="flex cursor-pointer items-center gap-2 text-xs text-mist/50">
          {{ 'settings.advancedMode' | transloco }}
          <button
            type="button"
            role="switch"
            [attr.aria-checked]="draft.draft().fileIgnoreAdvanced"
            class="relative h-5 w-9 shrink-0 rounded-full transition-colors"
            [class]="draft.draft().fileIgnoreAdvanced ? 'bg-accent' : 'bg-white/15'"
            (click)="toggleAdvanced()"
          >
            <span
              class="absolute top-0.5 h-4 w-4 rounded-full transition-all"
              [class]="draft.draft().fileIgnoreAdvanced ? 'left-4.5 bg-ink' : 'left-0.5 bg-white'"
            ></span>
          </button>
        </label>
      </div>
      <p class="mb-4 text-xs text-mist/30">{{ 'settings.fileAccessRulesHint' | transloco }}</p>

      <div class="space-y-3">
        <div class="rounded-xl border border-white/10 bg-ink/40 px-4 py-3">
          <div class="flex items-start gap-3">
            <button
              type="button"
              role="switch"
              [attr.aria-checked]="isOn('ignoreGitignored')"
              class="relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors"
              [class]="isOn('ignoreGitignored') ? 'bg-accent' : 'bg-white/15'"
              (click)="toggle('ignoreGitignored')"
            >
              <span
                class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
                [class]="isOn('ignoreGitignored') ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
              ></span>
            </button>
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
              <button
                type="button"
                role="switch"
                [attr.aria-checked]="isOn('scanGeneratedFiles')"
                class="relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors"
                [class]="isOn('scanGeneratedFiles') ? 'bg-accent' : 'bg-white/15'"
                (click)="toggle('scanGeneratedFiles')"
              >
                <span
                  class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
                  [class]="isOn('scanGeneratedFiles') ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
                ></span>
              </button>
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
            <button
              type="button"
              role="switch"
              [attr.aria-checked]="isOn('ignoreLocalDatabases')"
              class="relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors"
              [class]="isOn('ignoreLocalDatabases') ? 'bg-accent' : 'bg-white/15'"
              (click)="toggle('ignoreLocalDatabases')"
            >
              <span
                class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
                [class]="isOn('ignoreLocalDatabases') ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
              ></span>
            </button>
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
            <button
              type="button"
              role="switch"
              [attr.aria-checked]="isOn('ignoreEnvFiles')"
              class="relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors"
              [class]="isOn('ignoreEnvFiles') ? 'bg-accent' : 'bg-white/15'"
              (click)="toggle('ignoreEnvFiles')"
            >
              <span
                class="absolute top-0.5 h-5 w-5 rounded-full transition-all"
                [class]="isOn('ignoreEnvFiles') ? 'left-5.5 bg-ink' : 'left-0.5 bg-white'"
              ></span>
            </button>
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
                  <button
                    type="button"
                    role="switch"
                    [attr.aria-checked]="groupActive(group.key)"
                    class="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                    [class]="groupActive(group.key) ? 'bg-accent' : 'bg-white/15'"
                    (click)="toggleGroup(group.key)"
                  >
                    <span
                      class="absolute top-0.5 h-4 w-4 rounded-full transition-all"
                      [class]="groupActive(group.key) ? 'left-4.5 bg-ink' : 'left-0.5 bg-white'"
                    ></span>
                  </button>
                }
              </div>
              <div class="grid grid-cols-2 gap-1.5">
                @for (entry of catalogFor(group.key); track entry.id) {
                  <div
                    class="flex items-center justify-between gap-2 rounded-lg border border-white/10 px-3 py-1.5"
                  >
                    <code class="truncate font-mono text-xs text-mist/70">{{ entry.pattern }}</code>
                    <button
                      type="button"
                      role="switch"
                      [attr.aria-checked]="isRuleOn(entry)"
                      class="relative h-4 w-7 shrink-0 rounded-full transition-colors"
                      [class]="isRuleOn(entry) ? 'bg-accent' : 'bg-white/15'"
                      (click)="toggleRule(entry)"
                    >
                      <span
                        class="absolute top-0.5 h-3 w-3 rounded-full transition-all"
                        [class]="isRuleOn(entry) ? 'left-3.5 bg-ink' : 'left-0.5 bg-white'"
                      ></span>
                    </button>
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
          (input)="newExemption.set($any($event.target).value)"
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
      <div class="space-y-1.5">
        @for (rule of commandRules(); track rule) {
          <div
            class="flex items-center justify-between rounded-xl border border-white/10 bg-ink/40 px-4 py-2"
          >
            <code class="font-mono text-sm text-mist">{{ rule }}</code>
            <button
              type="button"
              class="text-mist/40 transition-colors hover:text-rose-400"
              (click)="deleteRule(rule)"
            >
              ✕
            </button>
          </div>
        } @empty {
          <p class="text-sm text-mist/30">{{ 'settings.noCommandRules' | transloco }}</p>
        }
      </div>
      <div class="mt-3 flex gap-2">
        <input
          class="field min-w-0 flex-1 rounded-xl px-4 py-2 font-mono text-sm"
          [placeholder]="'settings.rulePlaceholder' | transloco"
          [value]="newRule()"
          (input)="newRule.set($any($event.target).value)"
          (keydown.enter)="addRule()"
        />
        <button
          type="button"
          class="rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5"
          (click)="addRule()"
        >
          {{ 'settings.addRule' | transloco }}
        </button>
      </div>
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.commandRulesHint' | transloco }}</p>
    </section>

    <section class="mt-8">
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.websiteRules' | transloco }}
      </h3>
      <div class="space-y-1.5">
        @for (rule of allowedWebsites(); track rule) {
          <div
            class="flex items-center justify-between rounded-xl border border-white/10 bg-ink/40 px-4 py-2"
          >
            <code class="font-mono text-sm text-emerald-300">{{ rule }}</code>
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
      <div class="mt-3 space-y-1.5">
        @for (rule of deniedWebsites(); track rule) {
          <div
            class="flex items-center justify-between rounded-xl border border-rose-500/20 bg-ink/40 px-4 py-2"
          >
            <code class="font-mono text-sm text-rose-300">{{ rule }}</code>
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
          (input)="newWebsite.set($any($event.target).value)"
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
      <p class="mt-2 text-xs text-mist/30">{{ 'settings.websiteRulesHint' | transloco }}</p>
    </section>
  `,
})
export class AgentRulesSettings {
  private readonly settingsService = inject(SettingsService);
  protected readonly draft = inject(SettingsDraftService);

  protected readonly newExemption = signal('');
  protected readonly fileIgnoreExemptions = () => this.draft.draft().fileIgnoreExemptions;

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
  protected readonly commandRules = () => this.settingsService.settings()?.commandRules ?? [];
  protected readonly newWebsite = signal('');
  protected readonly allowedWebsites = () => this.settingsService.settings()?.allowedWebsites ?? [];
  protected readonly deniedWebsites = () => this.settingsService.settings()?.deniedWebsites ?? [];

  protected async addRule(): Promise<void> {
    const rule = this.newRule().trim();
    if (!rule) {
      return;
    }
    await this.settingsService.addCommandRule(rule);
    this.newRule.set('');
  }

  protected async deleteRule(rule: string): Promise<void> {
    await this.settingsService.deleteCommandRule(rule);
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
