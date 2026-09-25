import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChildren,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { homeDir } from '@tauri-apps/api/path';
import {
  CommandRiskLevel,
  CommandRule,
  CommandScopeOption,
  PermissionDefaultAction,
  PermissionRequestEvent,
} from '../core/models';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { CopyButton } from './copy-button';

type PermissionDecision = 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always';

type CommandPartStatus = 'allowed' | 'pending' | 'plain';

interface CommandPart {
  text: string;
  status: CommandPartStatus;
}

interface PermissionAction {
  id: string;
  labelKey: string;
  decision: PermissionDecision;
  variant: 'danger' | 'neutral' | 'primary';
}

interface SegmentScope {
  index: number;
  text: string;
  options: CommandScopeOption[];
  reason: string | null;
  folders: string[];
}

@Component({
  selector: 'app-permission-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, CopyButton],
  host: {
    '(document:keydown)': 'onKeydown($event)',
  },
  template: `
    <div class="pointer-events-none absolute inset-0 z-40 flex flex-col justify-end px-5 pb-3">
      <div
        class="pointer-events-auto mx-auto max-h-full w-full max-w-4xl overflow-y-auto rounded-2xl border border-accent/30 bg-navy/95 shadow-2xl shadow-black/50 backdrop-blur"
      >
        <header class="flex items-center gap-3 px-5 pt-4">
          <span
            class="rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider"
            [class]="
              request().promptKind === 'command'
                ? 'bg-accent/15 text-accent'
                : isWeb()
                  ? 'bg-sky-500/15 text-sky-300'
                  : request().promptKind === 'folder'
                    ? 'bg-white/10 text-mist'
                    : 'bg-rose-500/15 text-rose-300'
            "
          >
            {{ ('permission.kind.' + request().promptKind) | transloco }}
          </span>
          <h2 class="min-w-0 flex-1 text-sm font-semibold text-white">{{ request().title }}</h2>
          @if (request().risk; as risk) {
            <span class="group relative shrink-0">
              <span
                tabindex="0"
                class="inline-flex cursor-help items-center rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                [class]="riskClass(risk.level)"
              >
                {{ ('permission.risk.' + risk.level) | transloco }}
              </span>
              <span
                class="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden w-64 rounded-lg border border-white/10 bg-navy px-3 py-2 text-xs font-normal normal-case tracking-normal text-mist shadow-xl group-hover:block group-focus-within:block"
              >
                {{ risk.detail }}
              </span>
            </span>
          }
        </header>

        <div class="space-y-3 px-5 py-3">
          @if (segmentScopes().length > 0) {
            <p class="text-sm leading-relaxed text-mist/60">
              {{
                'permission.segment.summary'
                  | transloco: { count: segmentScopes().length, total: request().segments.length }
              }}
            </p>
          } @else {
            <p class="text-sm leading-relaxed text-mist/60">{{ request().detail }}</p>
          }

          @if (request().command; as command) {
            @if (commandParts(); as parts) {
              <div class="relative">
                <pre
                  class="max-h-40 overflow-auto rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm text-mist"
                >@for (part of parts; track $index) {<span [class]="partClass(part.status)">{{ part.text }}</span>}</pre>
                <app-copy-button
                  class="absolute top-2 right-2"
                  [text]="command"
                  buttonClass="h-6 w-6 border-white/10 bg-white/5 text-mist/40 hover:border-accent/40 hover:bg-accent/15 hover:text-accent"
                />
              </div>
              <div class="flex flex-wrap items-center gap-3 text-xs text-mist/40">
                <span class="inline-flex items-center gap-1.5">
                  <span class="h-2 w-2 rounded-full bg-mist/40"></span>
                  {{ 'permission.segment.allowed' | transloco }}
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <span class="h-2 w-2 rounded-full bg-accent"></span>
                  {{ 'permission.segment.needsApproval' | transloco }}
                </span>
              </div>
            } @else {
              <div class="relative">
                <pre
                  class="max-h-40 overflow-auto rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm text-mist"
                  >{{ command }}</pre>
                <app-copy-button
                  class="absolute top-2 right-2"
                  [text]="command"
                  buttonClass="h-6 w-6 border-white/10 bg-white/5 text-mist/40 hover:border-accent/40 hover:bg-accent/15 hover:text-accent"
                />
              </div>
            }
          }

          @if (request().folder; as folder) {
            <div
              class="rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm text-mist"
            >
              {{ folder }}
            </div>
          }

          @if (request().url; as url) {
            <div
              class="break-all rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm text-mist"
            >
              {{ url }}
            </div>
          }

          @if (isWeb()) {
            <div>
              <label class="mb-1.5 block text-sm text-mist/50">
                {{ 'permission.siteRuleLabel' | transloco }}
              </label>
              <input
                class="field w-full rounded-xl px-4 py-2 font-mono text-sm"
                [value]="rule()"
                (input)="onRuleInput($event)"
              />
              <p class="mt-1.5 text-xs text-mist/30">
                {{ 'permission.siteRuleHint' | transloco }}
              </p>
            </div>
          } @else if (request().promptKind === 'command' && segmentScopes().length > 0) {
            <div>
              <label class="mb-1.5 block text-sm text-mist/50">
                {{ 'permission.segment.title' | transloco }}
              </label>
              <div class="space-y-3">
                @for (group of segmentScopes(); track group.index) {
                  <div data-testid="asking-segment">
                    <code class="block truncate font-mono text-xs text-mist/70">{{
                      group.text
                    }}</code>
                    @if (group.reason) {
                      <p class="mt-0.5 text-xs text-mist/40">{{ group.reason }}</p>
                    }
                    @if (group.options.length > 0) {
                      <div class="mt-1.5 space-y-1.5">
                        @for (option of group.options; track ruleKey(option.rule)) {
                          <button
                            type="button"
                            class="flex w-full items-center gap-3 rounded-xl border px-4 py-2 text-left transition-colors"
                            [class]="segmentScopeClass(group.index, option.rule)"
                            (click)="selectSegmentRule(group.index, option.rule)"
                          >
                            <span
                              class="h-2.5 w-2.5 shrink-0 rounded-full"
                              [class]="
                                ruleKey(selectedSegmentRule(group.index)) === ruleKey(option.rule)
                                  ? 'bg-accent'
                                  : 'bg-white/20'
                              "
                            ></span>
                            <span class="shrink-0 text-xs text-mist/50">
                              {{ ('settings.scope.' + option.kind) | transloco }}
                            </span>
                            <code class="ml-auto truncate font-mono text-xs text-mist">{{
                              option.rule.value
                            }}</code>
                          </button>
                        }
                      </div>
                    } @else if (group.folders.length > 0) {
                      <p class="mt-0.5 text-xs text-accent/70">
                        {{ 'permission.segment.folderOnly' | transloco }}
                      </p>
                    }
                  </div>
                }
              </div>
              @if (hasSegmentRuleOptions()) {
                <p class="mt-1.5 text-xs text-mist/30">
                  {{ 'permission.scope.hint' | transloco }}
                </p>
              }
            </div>
          } @else if (request().promptKind === 'command' && scopeOptions().length > 0) {
            <div>
              <label class="mb-1.5 block text-sm text-mist/50">
                {{ 'permission.scope.title' | transloco }}
              </label>
              <div class="space-y-1.5">
                @for (option of scopeOptions(); track ruleKey(option.rule)) {
                  <button
                    type="button"
                    class="flex w-full items-center gap-3 rounded-xl border px-4 py-2 text-left transition-colors"
                    [class]="scopeOptionClass(option.rule)"
                    (click)="selectedScopeRule.set(option.rule)"
                  >
                    <span
                      class="h-2.5 w-2.5 shrink-0 rounded-full"
                      [class]="
                        ruleKey(selectedScopeRule()) === ruleKey(option.rule)
                          ? 'bg-accent'
                          : 'bg-white/20'
                      "
                    ></span>
                    <span class="shrink-0 text-xs text-mist/50">
                      {{ ('settings.scope.' + option.kind) | transloco }}
                    </span>
                    <code class="ml-auto truncate font-mono text-xs text-mist">{{
                      option.rule.value
                    }}</code>
                  </button>
                }
              </div>
              <p class="mt-1.5 text-xs text-mist/30">
                {{ 'permission.scope.hint' | transloco }}
              </p>
            </div>
          }

          @if (folderOptions().length > 0) {
            <div>
              <label class="mb-1.5 block text-sm text-mist/50">
                {{ 'permission.folderScope.title' | transloco }}
              </label>
              @if (
                request().promptKind === 'command' &&
                segmentScopes().length === 0 &&
                scopeOptions().length === 0
              ) {
                <p class="mb-1.5 text-xs text-accent/70">
                  {{ 'permission.segment.folderOnly' | transloco }}
                </p>
              }
              <div class="space-y-1.5">
                @for (folder of folderOptions(); track folder) {
                  <button
                    type="button"
                    class="flex w-full items-center gap-3 rounded-xl border px-4 py-2 text-left transition-colors"
                    [class]="folderOptionClass(folder)"
                    [attr.title]="folder"
                    (click)="toggleFolder(folder)"
                  >
                    <span
                      class="h-2.5 w-2.5 shrink-0 rounded-full"
                      [class]="selectedFolders().includes(folder) ? 'bg-accent' : 'bg-white/20'"
                    ></span>
                    <span class="shrink-0 text-xs text-mist/50">
                      {{ 'permission.folderScope.option' | transloco }}
                    </span>
                    <code class="ml-auto truncate font-mono text-xs text-mist">{{
                      displayFolder(folder)
                    }}</code>
                  </button>
                }
              </div>
              <p class="mt-1.5 text-xs text-mist/30">
                {{ 'permission.folderScope.hint' | transloco }}
              </p>
            </div>
          }
        </div>

        <footer class="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-3">
          @for (action of actions(); track action.id; let index = $index) {
            <button
              #actionButton
              type="button"
              [class]="actionClass(action, index === activeIndex())"
              (click)="run(action)"
              (focus)="activeIndex.set(index)"
            >
              {{ action.labelKey | transloco }}
            </button>
          }
        </footer>
      </div>
    </div>
  `,
})
export class PermissionOverlay {
  readonly request = input.required<PermissionRequestEvent>();
  protected readonly workspace = inject(WorkspaceService);
  private readonly settings = inject(SettingsService);
  protected readonly rule = signal('');
  protected readonly selectedScopeRule = signal<CommandRule | null>(null);
  protected readonly activeIndex = signal(0);

  private readonly actionButtons = viewChildren<ElementRef<HTMLButtonElement>>('actionButton');
  private focusedRequestId = '';

  protected readonly isWeb = computed(() => {
    const kind = this.request().promptKind;
    return kind === 'web' || kind === 'websearch';
  });

  protected readonly scopeOptions = computed(() => this.request().scopeOptions ?? []);

  /// Outside-project directories the command touched, each of which can be
  /// whitelisted (with everything below it) from the prompt.
  protected readonly folderOptions = computed(() => this.request().folders ?? []);

  protected readonly selectedFolders = signal<string[]>([]);

  protected readonly selectedSegmentRules = signal<Record<number, CommandRule>>({});

  /// One entry per part of a compound command that still needs approval, each
  /// with its own reason and allow/deny scopes so the user can grant a rule per
  /// part. A part blocked only by an outside path carries no scopes (a command
  /// rule can never allow it) and points at the folder options instead.
  protected readonly segmentScopes = computed<SegmentScope[]>(() => {
    const segments = this.request().segments ?? [];
    if (segments.length < 2) {
      return [];
    }
    const groups: SegmentScope[] = [];
    segments.forEach((segment, index) => {
      if (!segment.allowed) {
        groups.push({
          index,
          text: segment.text.trim(),
          options: segment.scopeOptions ?? [],
          reason: segment.reason ?? null,
          folders: segment.folders ?? [],
        });
      }
    });
    return groups;
  });

  protected readonly hasSegmentRuleOptions = computed(() =>
    this.segmentScopes().some((group) => group.options.length > 0),
  );

  /// The user's home directory, used only to shorten displayed folders to
  /// `~/…`. Resolved lazily; outside Tauri it stays empty and paths show in full.
  private readonly home = signal('');

  protected readonly commandParts = computed<CommandPart[] | null>(() => {
    const command = this.request().command;
    const segments = this.request().segments;
    if (!command || segments.length < 2) {
      return null;
    }
    const parts: CommandPart[] = [];
    let cursor = 0;
    for (const segment of segments) {
      const index = command.indexOf(segment.text, cursor);
      if (index < 0) {
        return null;
      }
      if (index > cursor) {
        parts.push({ text: command.slice(cursor, index), status: 'plain' });
      }
      parts.push({
        text: command.slice(index, index + segment.text.length),
        status: segment.allowed ? 'allowed' : 'pending',
      });
      cursor = index + segment.text.length;
    }
    if (cursor < command.length) {
      parts.push({ text: command.slice(cursor), status: 'plain' });
    }
    return parts;
  });

  private readonly defaultAction = computed<PermissionDefaultAction>(() => {
    const defaults = this.settings.settings()?.permissionDefaults;
    const kind = this.request().promptKind;
    if (kind === 'file') {
      return 'once';
    }
    if (this.isWeb()) {
      return defaults?.website ?? 'once';
    }
    if (kind === 'folder') {
      return defaults?.folder ?? 'once';
    }
    return defaults?.command ?? 'once';
  });

  protected readonly actions = computed<PermissionAction[]>(() => {
    const kind = this.request().promptKind;
    if (kind === 'command') {
      return [
        { id: 'deny', labelKey: 'permission.deny', decision: 'deny', variant: 'danger' },
        {
          id: 'deny_always',
          labelKey: 'permission.denyAlways',
          decision: 'deny_always',
          variant: 'danger',
        },
        {
          id: 'allow',
          labelKey: 'permission.allowOnce',
          decision: 'allow_once',
          variant: 'neutral',
        },
        {
          id: 'allow_session',
          labelKey: 'permission.allowChat',
          decision: 'allow_session',
          variant: 'neutral',
        },
        {
          id: 'allow_always',
          labelKey: 'permission.allowAlways',
          decision: 'allow_always',
          variant: 'primary',
        },
      ];
    }
    // opencode-style: every prompt offers once + session + always side by
    // side, so the grant that stops repeat prompts is always one click away.
    // `permissionDefaults` only picks which allow button is focused.
    const actions: PermissionAction[] = [
      { id: 'deny', labelKey: 'permission.deny', decision: 'deny', variant: 'danger' },
    ];
    if (this.isWeb()) {
      actions.push({
        id: 'deny_always',
        labelKey: 'permission.denyAlways',
        decision: 'deny_always',
        variant: 'danger',
      });
    }
    actions.push({
      id: 'allow',
      labelKey: 'permission.allowOnce',
      decision: 'allow_once',
      variant: 'neutral',
    });
    if (kind !== 'file') {
      actions.push({
        id: 'allow_session',
        labelKey: 'permission.allowSession',
        decision: 'allow_session',
        variant: 'neutral',
      });
      actions.push({
        id: 'allow_always',
        labelKey: kind === 'folder' ? 'permission.addFolder' : 'permission.allowAlways',
        decision: 'allow_always',
        variant: 'primary',
      });
    }
    return actions;
  });

  private readonly defaultIndex = computed(() => {
    const actions = this.actions();
    const preferred =
      this.defaultAction() === 'session'
        ? actions.findIndex((action) => action.id === 'allow_session')
        : actions.findIndex((action) => action.id === 'allow');
    if (preferred >= 0) {
      return preferred;
    }
    return actions.findIndex(
      (action) => action.id === 'allow' || action.id === 'allow_session',
    );
  });

  constructor() {
    homeDir()
      .then((home) => this.home.set(home))
      .catch(() => undefined);

    effect(() => {
      this.rule.set(this.request().suggestedRule ?? '');
      this.selectedFolders.set(this.defaultFolders());
      const selection: Record<number, CommandRule> = {};
      for (const group of this.segmentScopes()) {
        const preferred =
          group.options.find((option) => option.kind === 'program') ??
          group.options[group.options.length - 1];
        if (preferred) {
          selection[group.index] = preferred.rule;
        }
      }
      this.selectedSegmentRules.set(selection);
      const options = this.scopeOptions();
      const preferred =
        options.find((option) => option.kind === 'program') ?? options[options.length - 1];
      this.selectedScopeRule.set(preferred?.rule ?? null);
    });

    afterRenderEffect(() => {
      const request = this.request();
      const buttons = this.actionButtons();
      const index = this.defaultIndex();
      if (request.requestId === this.focusedRequestId) {
        return;
      }
      if (index < 0 || index >= buttons.length) {
        return;
      }
      this.focusedRequestId = request.requestId;
      this.activeIndex.set(index);
      buttons[index].nativeElement.focus();
    });
  }

  protected riskClass(level: CommandRiskLevel): string {
    switch (level) {
      case 'danger':
        return 'bg-rose-500/15 text-rose-300';
      case 'high':
        return 'bg-orange-500/15 text-orange-300';
      case 'medium':
        return 'bg-amber-500/15 text-amber-300';
      default:
        return 'bg-sky-500/15 text-sky-300';
    }
  }

  protected partClass(status: CommandPartStatus): string {
    switch (status) {
      case 'allowed':
        return 'text-mist/40';
      case 'pending':
        return 'rounded bg-accent/10 text-accent';
      default:
        return '';
    }
  }

  protected ruleKey(rule: CommandRule | null): string {
    return JSON.stringify(rule ? [rule.kind, rule.value] : null);
  }

  protected scopeOptionClass(rule: CommandRule): string {
    return this.ruleKey(this.selectedScopeRule()) === this.ruleKey(rule)
      ? 'border-accent/60 bg-accent/10'
      : 'border-white/10 hover:bg-white/5';
  }

  protected folderOptionClass(folder: string): string {
    return this.selectedFolders().includes(folder)
      ? 'border-accent/60 bg-accent/10'
      : 'border-white/10 hover:bg-white/5';
  }

  protected toggleFolder(folder: string): void {
    this.selectedFolders.update((folders) =>
      folders.includes(folder) ? folders.filter((entry) => entry !== folder) : [...folders, folder],
    );
  }

  /// Folders preselected for a new prompt: when a part can only be allowed by
  /// a folder grant (it has no rule scopes), its most specific folder is picked
  /// so "Allow always" / "Allow in this chat" actually stop the repeat prompt.
  /// Broader parent folders are never preselected.
  private defaultFolders(): string[] {
    const offered = this.folderOptions();
    if (offered.length === 0 || this.request().promptKind !== 'command') {
      return [];
    }
    const groups = this.segmentScopes();
    const picks =
      groups.length > 0
        ? groups
            .filter((group) => group.options.length === 0 && group.folders.length > 0)
            .map((group) => group.folders[0])
        : this.scopeOptions().length === 0
          ? [offered[0]]
          : [];
    return picks.filter((folder, index) => offered.includes(folder) && picks.indexOf(folder) === index);
  }

  /// Shortens a folder below the home directory to `~/…` for display. The full
  /// path is still what gets granted and is shown as the tooltip.
  protected displayFolder(folder: string): string {
    const home = this.home().replace(/[\\/]+$/, '');
    if (!home) {
      return folder;
    }
    if (folder === home) {
      return '~';
    }
    for (const separator of ['/', '\\']) {
      if (folder.startsWith(home + separator)) {
        return '~' + separator + folder.slice(home.length + 1);
      }
    }
    return folder;
  }

  protected selectedSegmentRule(index: number): CommandRule | null {
    return this.selectedSegmentRules()[index] ?? null;
  }

  protected selectSegmentRule(index: number, rule: CommandRule): void {
    this.selectedSegmentRules.update((selection) => ({ ...selection, [index]: rule }));
  }

  protected segmentScopeClass(index: number, rule: CommandRule): string {
    return this.ruleKey(this.selectedSegmentRule(index)) === this.ruleKey(rule)
      ? 'border-accent/60 bg-accent/10'
      : 'border-white/10 hover:bg-white/5';
  }

  /// The rules the allow/deny buttons should persist: one per asking part of a
  /// compound command, otherwise the single selected scope.
  private chosenRules(): CommandRule[] {
    const groups = this.segmentScopes();
    if (groups.length > 0) {
      return groups
        .map((group) => this.selectedSegmentRule(group.index))
        .filter((rule): rule is CommandRule => rule !== null);
    }
    const single = this.selectedScopeRule();
    return single ? [single] : [];
  }

  protected actionClass(action: PermissionAction, active: boolean): string {
    const base = 'rounded-full border px-4 py-2 text-sm transition-colors focus:outline-none';
    if (active) {
      return `${base} border-accent bg-accent font-semibold text-ink`;
    }
    switch (action.variant) {
      case 'danger':
        return `${base} border-rose-500/30 text-rose-300 hover:bg-rose-500/10`;
      case 'primary':
        return `${base} border-accent/50 text-accent hover:bg-accent/10`;
      default:
        return `${base} border-white/15 text-mist hover:bg-white/5`;
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || event.isComposing) {
      return;
    }
    if (this.settings.dialogOpen() || this.workspace.debugOpen()) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
    ) {
      return;
    }
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        this.move(-1);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        this.move(1);
        break;
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        this.activate();
        break;
    }
  }

  private move(delta: number): void {
    const count = this.actions().length;
    if (count === 0) {
      return;
    }
    const next = (this.activeIndex() + delta + count) % count;
    this.activeIndex.set(next);
    this.actionButtons()[next]?.nativeElement.focus();
  }

  private activate(): void {
    const action = this.actions()[this.activeIndex()];
    if (action) {
      this.run(action);
    }
  }

  protected onRuleInput(event: Event): void {
    this.rule.set((event.target as HTMLInputElement).value);
  }

  protected run(action: PermissionAction): void {
    const folders = this.selectedFolders();
    if (action.decision === 'allow_always') {
      void this.workspace.resolvePermission('allow_always', this.chosenRules(), folders);
      return;
    }
    if (action.decision === 'deny_always') {
      void this.workspace.resolvePermission('deny_always', this.chosenRules(), []);
      return;
    }
    if (action.decision === 'allow_session' && this.request().promptKind === 'command') {
      void this.workspace.resolvePermission('allow_session', this.chosenRules(), folders);
      return;
    }
    void this.workspace.resolvePermission(action.decision);
  }
}
