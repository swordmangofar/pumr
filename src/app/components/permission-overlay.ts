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

/** One numbered choice of the prompt. */
interface PermissionAction {
  id: string;
  labelKey: string;
  /** Explains what the choice covers and how long it lasts. */
  tooltipKey: string;
  decision: PermissionDecision;
  danger: boolean;
  /** What the choice remembers, shown as chips after the label. */
  grants: string[];
}

interface SegmentScope {
  index: number;
  text: string;
  options: CommandScopeOption[];
  reason: string | null;
  folders: string[];
  hosts: string[];
}

interface UrlParts {
  scheme: string;
  host: string;
  path: string;
  query: string;
  hash: string;
  suspicious: boolean;
}

/// Second-level labels that are public suffixes in many countries (`co.uk`).
const PUBLIC_SECOND_LEVELS = ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go'];

/// Mirrors the backend's `website_rule_fits` for an allow rule: it must cover
/// the host and stay narrow (the host, or a domain of it with at least two
/// labels, optionally as `*.domain`). The backend has the final say.
export function websiteRuleFits(rule: string, host: string): boolean {
  const normalized = rule.trim().replace(/\.$/, '').toLowerCase();
  const target = host.trim().replace(/\.$/, '').toLowerCase();
  if (!normalized || !target) {
    return false;
  }
  const domain = normalized.startsWith('*.') ? normalized.slice(2) : normalized;
  if (/[*?[\]{}]/.test(domain)) {
    return false;
  }
  if (target !== domain && !target.endsWith('.' + domain)) {
    return false;
  }
  if (/^[\d.]+$/.test(domain) || domain.includes(':')) {
    return true;
  }
  const labels = domain.split('.').filter((label) => label.length > 0);
  if (labels.length < 2) {
    return false;
  }
  if (labels.length === 2) {
    const [second, top] = labels;
    return !(top.length === 2 && PUBLIC_SECOND_LEVELS.includes(second));
  }
  return true;
}

/// Mirrors the backend's website rule matching: a glob over the host, where a
/// plain domain also covers its subdomains. A deny rule only has to cover the
/// host it was typed for.
export function websiteRuleCovers(rule: string, host: string): boolean {
  const normalized = rule.trim().replace(/\.$/, '').toLowerCase();
  const target = host.trim().replace(/\.$/, '').toLowerCase();
  if (!normalized || !target) {
    return false;
  }
  const matches = (glob: string) =>
    new RegExp(
      '^' +
        glob
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$',
    ).test(target);
  return matches(normalized) || (!normalized.includes('*') && matches('*.' + normalized));
}

/// True when a query string carries enough data to leak something: it is very
/// long, or one of its values looks like an encoded blob (base64, hex, tokens).
export function queryLooksLikeData(search: string): boolean {
  const query = search.replace(/^\?/, '');
  if (!query) {
    return false;
  }
  if (query.length > 150) {
    return true;
  }
  return query.split('&').some((pair) => {
    const raw = pair.split('=').slice(1).join('=');
    let value = raw;
    try {
      value = decodeURIComponent(raw.replace(/\+/g, ' '));
    } catch {
      // Keep the raw value.
    }
    return /^[A-Za-z0-9+/_=.-]{32,}$/.test(value);
  });
}

/// The narrowest scope worth remembering by default: a subcommand
/// (`git push *`), else the program (`kill *`), else what is offered last (the
/// exact line).
function preferredScope(options: CommandScopeOption[]): CommandScopeOption | undefined {
  return (
    options.find((option) => option.kind === 'subcommand') ??
    options.find((option) => option.kind === 'program') ??
    options[options.length - 1]
  );
}

/// The offered folders that no other offered folder lies inside: the folder
/// of each touched path, without the broader parents offered next to it.
function mostSpecificFolders(folders: string[]): string[] {
  const inside = (child: string, parent: string) =>
    child !== parent && (child.startsWith(parent + '/') || child.startsWith(parent + '\\'));
  return folders.filter(
    (folder, index) =>
      folders.indexOf(folder) === index && !folders.some((other) => inside(other, folder)),
  );
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
        class="pointer-events-auto mx-auto max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl border border-accent/30 bg-navy/95 shadow-2xl shadow-black/50 backdrop-blur"
        role="dialog"
        [attr.aria-label]="request().title"
      >
        <header class="flex items-center gap-3 px-5 pt-4">
          <span
            class="rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider"
            [class]="kindClass()"
          >
            {{ ('permission.kind.' + request().promptKind) | transloco }}
          </span>
          <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-white">
            {{ request().title }}
          </h2>
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
          @if (justification(); as justification) {
            <p class="text-sm leading-relaxed text-mist" data-testid="justification">
              <span class="mr-1.5 text-xs font-medium uppercase tracking-wider text-accent/70">{{
                'permission.justification' | transloco
              }}</span>
              {{ justification }}
            </p>
          }

          @if (request().command; as command) {
            <div class="relative">
              @if (commandParts(); as parts) {
                <pre [class]="commandClass" data-testid="command">@for (part of parts; track $index) {<span [class]="partClass(part.status)">{{ part.text }}</span>}</pre>
              } @else {
                <pre [class]="commandClass" data-testid="command">{{ command }}</pre>
              }
              <app-copy-button
                class="absolute top-2 right-2"
                [text]="command"
                buttonClass="h-6 w-6 border-white/10 bg-white/5 text-mist/40 hover:border-accent/40 hover:bg-accent/15 hover:text-accent"
              />
            </div>
          } @else if (request().url) {
            @if (urlParts(); as parts) {
              <div
                class="rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm break-all text-mist"
                data-testid="url"
              >
                <span class="text-mist/40">{{ parts.scheme }}</span
                ><span class="font-semibold text-white">{{ parts.host }}</span
                ><span>{{ parts.path }}</span
                ><span
                  [class]="parts.suspicious ? 'rounded bg-amber-500/15 text-amber-300' : 'text-mist/60'"
                  >{{ parts.query }}</span
                ><span class="text-mist/40">{{ parts.hash }}</span>
              </div>
              @if (parts.suspicious) {
                <p class="text-xs text-amber-300/80" data-testid="url-warning">
                  {{ 'permission.url.queryWarning' | transloco }}
                </p>
              }
            } @else {
              <div
                class="rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm break-all text-mist"
              >
                {{ request().url }}
              </div>
            }
          } @else if (location()) {
            <div
              class="rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm break-all text-mist"
            >
              {{ location() }}
            </div>
          }

          @if (reasons().length > 0) {
            <ul class="space-y-0.5 text-xs leading-relaxed text-mist/60" data-testid="reasons">
              @for (reason of reasons(); track reason) {
                <li>{{ reason }}</li>
              }
            </ul>
          }

          <div class="space-y-1" data-testid="options">
            @for (action of actions(); track action.id; let index = $index) {
              <button
                #actionButton
                type="button"
                [class]="actionClass(action, index === active())"
                [attr.title]="action.tooltipKey | transloco"
                [attr.data-action]="action.id"
                (click)="run(action)"
                (focus)="activeIndex.set(index)"
              >
                <span class="w-4 shrink-0 text-right text-xs tabular-nums opacity-50">{{
                  index + 1
                }}</span>
                <span class="shrink-0">{{ action.labelKey | transloco }}</span>
                @if (action.grants.length > 0) {
                  <span class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                    @for (grant of action.grants; track $index) {
                      <code
                        class="max-w-[18rem] truncate rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs"
                        [attr.title]="grant"
                        >{{ grant }}</code
                      >
                    }
                  </span>
                }
              </button>
            }
          </div>

          @if (canCustomize()) {
            <button
              type="button"
              class="flex items-center gap-1.5 text-xs text-mist/40 transition-colors hover:text-mist"
              data-testid="customize"
              [attr.aria-expanded]="customizing()"
              (click)="customizing.set(!customizing())"
            >
              <span class="inline-block transition-transform" [class.rotate-90]="customizing()"
                >▸</span
              >
              {{ 'permission.customize' | transloco }}
            </button>
            @if (customizing()) {
              <div
                class="space-y-4 rounded-xl border border-white/10 bg-ink/30 p-3"
                data-testid="customize-panel"
              >
                @if (isWeb()) {
                  <div>
                    <label class="mb-1.5 block text-xs text-mist/50">
                      {{ 'permission.siteRuleLabel' | transloco }}
                    </label>
                    <input
                      class="field w-full rounded-xl px-4 py-2 font-mono text-sm"
                      [value]="rule()"
                      (input)="onRuleInput($event)"
                    />
                    @if (siteRuleFits()) {
                      <p class="mt-1.5 text-xs text-mist/30">
                        {{ 'permission.siteRuleHint' | transloco }}
                      </p>
                    } @else {
                      <p class="mt-1.5 text-xs text-amber-300/80" data-testid="site-rule-invalid">
                        {{ 'permission.siteRuleInvalid' | transloco: { host: requestHost() } }}
                      </p>
                    }
                  </div>
                }

                @if (segmentChoices().length > 0) {
                  <div>
                    <label class="mb-1.5 block text-xs text-mist/50">
                      {{ 'permission.scope.title' | transloco }}
                    </label>
                    <div class="space-y-3">
                      @for (group of segmentChoices(); track group.index) {
                        <div data-testid="asking-segment">
                          <code class="block truncate font-mono text-xs text-mist/70">{{
                            group.text
                          }}</code>
                          <div class="mt-1.5 space-y-1">
                            @for (option of group.options; track ruleKey(option.rule)) {
                              <button
                                type="button"
                                [class]="choiceClass(ruleKey(selectedSegmentRule(group.index)) === ruleKey(option.rule))"
                                (click)="selectSegmentRule(group.index, option.rule)"
                              >
                                <span class="shrink-0 text-xs text-mist/50">
                                  {{ ('settings.scope.' + option.kind) | transloco }}
                                </span>
                                <code class="ml-auto truncate font-mono text-xs text-mist">{{
                                  option.rule.value
                                }}</code>
                              </button>
                            }
                          </div>
                        </div>
                      }
                    </div>
                    <p class="mt-1.5 text-xs text-mist/30">
                      {{ 'permission.scope.hint' | transloco }}
                    </p>
                  </div>
                } @else if (segmentScopes().length === 0 && scopeOptions().length > 1) {
                  <div>
                    <label class="mb-1.5 block text-xs text-mist/50">
                      {{ 'permission.scope.title' | transloco }}
                    </label>
                    <div class="space-y-1">
                      @for (option of scopeOptions(); track ruleKey(option.rule)) {
                        <button
                          type="button"
                          [class]="choiceClass(ruleKey(selectedScopeRule()) === ruleKey(option.rule))"
                          (click)="selectedScopeRule.set(option.rule)"
                        >
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
                    <label class="mb-1.5 block text-xs text-mist/50">
                      {{ 'permission.folderScope.title' | transloco }}
                    </label>
                    <div class="space-y-1">
                      @for (folder of folderOptions(); track folder) {
                        <button
                          type="button"
                          [class]="choiceClass(selectedFolders().includes(folder))"
                          [attr.title]="folder"
                          data-testid="folder-option"
                          (click)="toggleFolder(folder)"
                        >
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

                @if (hostOptions().length > 0) {
                  <div>
                    <label class="mb-1.5 block text-xs text-mist/50">
                      {{ 'permission.hostScope.title' | transloco }}
                    </label>
                    <div class="space-y-1">
                      @for (host of hostOptions(); track host) {
                        <button
                          type="button"
                          [class]="choiceClass(selectedHosts().includes(host))"
                          data-testid="host-option"
                          (click)="toggleHost(host)"
                        >
                          <span class="shrink-0 text-xs text-mist/50">
                            {{ 'permission.hostScope.option' | transloco }}
                          </span>
                          <code class="ml-auto truncate font-mono text-xs text-mist">{{
                            host
                          }}</code>
                        </button>
                      }
                    </div>
                    <p class="mt-1.5 text-xs text-mist/30">
                      {{ 'permission.hostScope.hint' | transloco }}
                    </p>
                  </div>
                }
              </div>
            }
          }

          <p class="text-[11px] text-mist/30">
            {{ 'permission.keyboardHint' | transloco: { count: actions().length } }}
          </p>
        </div>
      </div>
    </div>
  `,
})
export class PermissionOverlay {
  readonly request = input.required<PermissionRequestEvent>();
  protected readonly workspace = inject(WorkspaceService);
  private readonly settings = inject(SettingsService);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly commandClass =
    'max-h-48 overflow-auto rounded-xl border border-white/10 bg-ink/60 py-3 pr-10 pl-4 font-mono text-sm break-words whitespace-pre-wrap text-mist';

  /// The website rule a website prompt remembers; editable under "Customize".
  protected readonly rule = signal('');
  protected readonly selectedScopeRule = signal<CommandRule | null>(null);
  protected readonly selectedSegmentRules = signal<Record<number, CommandRule>>({});
  protected readonly selectedFolders = signal<string[]>([]);
  protected readonly selectedHosts = signal<string[]>([]);
  protected readonly customizing = signal(false);
  protected readonly activeIndex = signal(0);

  private readonly actionButtons = viewChildren<ElementRef<HTMLButtonElement>>('actionButton');
  private focusedRequestId = '';

  /// The user's home directory, used only to shorten displayed folders to
  /// `~/…`. Resolved lazily; outside Tauri it stays empty and paths show in full.
  private readonly home = signal('');

  protected readonly isWeb = computed(() => {
    const kind = this.request().promptKind;
    return kind === 'web' || kind === 'websearch';
  });

  protected readonly scopeOptions = computed(() => this.request().scopeOptions ?? []);

  /// Outside-project directories the command touched, each of which can be
  /// whitelisted (with everything below it).
  protected readonly folderOptions = computed(() => this.request().folders ?? []);

  /// Websites a command contacts that are not allowed yet.
  protected readonly hostOptions = computed(() => this.request().hosts ?? []);

  /// One entry per part of a compound command that still needs approval.
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
          hosts: segment.hosts ?? [],
        });
      }
    });
    return groups;
  });

  /// Asking parts whose rule the user can choose (more than one scope).
  protected readonly segmentChoices = computed(() =>
    this.segmentScopes().filter((group) => group.options.length > 1),
  );

  /// Why the prompt asks: one line per distinct reason of the asking parts.
  /// Website and folder prompts need none: the title and the address say it.
  /** The assistant's own explanation of why it asks, if it gave one. */
  protected readonly justification = computed(() => this.request().justification?.trim() || null);

  protected readonly reasons = computed<string[]>(() => {
    if (this.isWeb() || this.request().promptKind === 'folder') {
      return [];
    }
    const unique: string[] = [];
    for (const group of this.segmentScopes()) {
      const reason = group.reason?.trim();
      if (reason && !unique.includes(reason)) {
        unique.push(reason);
      }
    }
    if (unique.length > 0) {
      return unique;
    }
    const detail = this.request().detail?.trim();
    return detail ? [detail] : [];
  });

  protected readonly commandParts = computed<CommandPart[] | null>(() => {
    const command = this.request().command;
    const segments = this.request().segments;
    if (!command || segments.length < 2) {
      return null;
    }
    const parts: CommandPart[] = [];
    let cursor = 0;
    for (const segment of segments) {
      const text = segment.text.trim();
      const index = command.indexOf(text, cursor);
      if (index < 0 || !text) {
        return null;
      }
      if (index > cursor) {
        parts.push({ text: command.slice(cursor, index), status: 'plain' });
      }
      parts.push({
        text: command.slice(index, index + text.length),
        status: segment.allowed ? 'allowed' : 'pending',
      });
      cursor = index + text.length;
    }
    if (cursor < command.length) {
      parts.push({ text: command.slice(cursor), status: 'plain' });
    }
    return parts;
  });

  /// The folder or file a folder or file prompt is about.
  protected readonly location = computed(
    () => this.request().folder ?? this.request().path ?? '',
  );

  /// The host a website prompt asked about.
  protected readonly requestHost = computed(() => {
    const url = this.request().url;
    if (!url) {
      return '';
    }
    try {
      return new URL(url).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return '';
    }
  });

  protected readonly siteRuleFits = computed(() => {
    const host = this.requestHost();
    return !host || websiteRuleFits(this.rule(), host);
  });

  /// The URL split for display, so the host stands out and data carried in
  /// the query string is visible.
  protected readonly urlParts = computed<UrlParts | null>(() => {
    const url = this.request().url;
    if (!url) {
      return null;
    }
    try {
      const parsed = new URL(url);
      return {
        scheme: parsed.protocol + '//',
        host: parsed.host,
        path: parsed.pathname,
        query: parsed.search,
        hash: parsed.hash,
        suspicious: queryLooksLikeData(parsed.search),
      };
    } catch {
      return null;
    }
  });

  /// What an allow choice would remember, mirroring what the backend saves:
  /// the chosen command rules, folders and hosts; the website rule; the
  /// folder of a folder prompt. Empty when nothing can be remembered, which
  /// hides the "don't ask again" choices.
  private readonly allowGrants = computed<string[]>(() => {
    const request = this.request();
    if (this.isWeb()) {
      const edited = this.rule().trim().toLowerCase();
      const rule =
        edited && this.siteRuleFits() ? edited : (request.suggestedRule ?? this.requestHost());
      return rule ? [rule] : [];
    }
    if (request.promptKind === 'folder') {
      return request.folder ? [this.displayFolder(request.folder)] : [];
    }
    if (request.promptKind !== 'command') {
      return [];
    }
    return [
      ...this.chosenRules().map((rule) => rule.value),
      ...this.selectedFolders().map((folder) => this.displayFolder(folder)),
      ...this.selectedHosts(),
    ];
  });

  /// What "always deny" would remember: the chosen rules, the exact command
  /// when the prompt offers no scopes, or the website rule.
  private readonly denyGrants = computed<string[]>(() => {
    const request = this.request();
    if (this.isWeb()) {
      const edited = this.rule().trim().toLowerCase();
      const host = this.requestHost();
      const rule =
        edited && websiteRuleCovers(edited, host) ? edited : (request.suggestedRule ?? host);
      return rule ? [rule] : [];
    }
    if (request.promptKind !== 'command') {
      return [];
    }
    const rules = this.chosenRules().map((rule) => rule.value);
    if (rules.length > 0) {
      return rules;
    }
    return this.scopeOptions().length === 0 && request.suggestedRule && request.command
      ? [request.command.trim()]
      : [];
  });

  protected readonly actions = computed<PermissionAction[]>(() => {
    const command = this.request().promptKind === 'command';
    const allowGrants = this.allowGrants();
    const denyGrants = this.denyGrants();
    const actions: PermissionAction[] = [
      {
        id: 'allow',
        labelKey: 'permission.option.yes',
        tooltipKey: 'permission.tooltip.allowOnce',
        decision: 'allow_once',
        danger: false,
        grants: [],
      },
    ];
    if (allowGrants.length > 0) {
      actions.push(
        {
          id: 'allow_session',
          labelKey: command ? 'permission.option.chat' : 'permission.option.session',
          tooltipKey: command ? 'permission.tooltip.allowChat' : 'permission.tooltip.allowSession',
          decision: 'allow_session',
          danger: false,
          grants: allowGrants,
        },
        {
          id: 'allow_always',
          labelKey: 'permission.option.always',
          tooltipKey: 'permission.tooltip.allowAlways',
          decision: 'allow_always',
          danger: false,
          grants: allowGrants,
        },
      );
    }
    actions.push({
      id: 'deny',
      labelKey: 'permission.option.no',
      tooltipKey: 'permission.tooltip.deny',
      decision: 'deny',
      danger: true,
      grants: [],
    });
    if (denyGrants.length > 0) {
      actions.push({
        id: 'deny_always',
        labelKey: 'permission.option.denyAlways',
        tooltipKey: 'permission.tooltip.denyAlways',
        decision: 'deny_always',
        danger: true,
        grants: denyGrants,
      });
    }
    return actions;
  });

  /// The highlighted choice, kept in range when the list shrinks.
  protected readonly active = computed(() =>
    Math.max(0, Math.min(this.activeIndex(), this.actions().length - 1)),
  );

  /// "Customize" appears only when there is something to choose.
  protected readonly canCustomize = computed(
    () =>
      this.isWeb() ||
      this.segmentChoices().length > 0 ||
      (this.segmentScopes().length === 0 && this.scopeOptions().length > 1) ||
      this.folderOptions().length > 0 ||
      this.hostOptions().length > 0,
  );

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

  /// The choice focused when the prompt opens: "don't ask again" when that is
  /// the configured default, except for high-risk prompts, where a single
  /// Enter should never remember anything.
  private readonly defaultIndex = computed(() => {
    const risky = ['high', 'danger'].includes(this.request().risk?.level ?? '');
    if (this.defaultAction() === 'session' && !risky) {
      const index = this.actions().findIndex((action) => action.id === 'allow_session');
      if (index >= 0) {
        return index;
      }
    }
    return 0;
  });

  constructor() {
    homeDir()
      .then((home) => this.home.set(home))
      .catch(() => undefined);

    // A new prompt starts from the narrowest useful grant.
    effect(() => {
      this.rule.set(this.request().suggestedRule ?? '');
      this.selectedFolders.set(mostSpecificFolders(this.folderOptions()));
      this.selectedHosts.set([...this.hostOptions()]);
      this.customizing.set(false);
      const selection: Record<number, CommandRule> = {};
      for (const group of this.segmentScopes()) {
        const preferred = preferredScope(group.options);
        if (preferred) {
          selection[group.index] = preferred.rule;
        }
      }
      this.selectedSegmentRules.set(selection);
      this.selectedScopeRule.set(preferredScope(this.scopeOptions())?.rule ?? null);
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

  protected kindClass(): string {
    if (this.request().promptKind === 'command') {
      return 'bg-accent/15 text-accent';
    }
    if (this.isWeb()) {
      return 'bg-sky-500/15 text-sky-300';
    }
    return this.request().promptKind === 'folder'
      ? 'bg-white/10 text-mist'
      : 'bg-rose-500/15 text-rose-300';
  }

  protected riskClass(level: CommandRiskLevel): string {
    switch (level) {
      case 'danger':
        return 'bg-rose-500/15 text-rose-300';
      case 'high':
        return 'bg-orange-500/15 text-orange-300';
      case 'network':
        return 'bg-violet-500/15 text-violet-300';
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
        return 'text-mist/40';
    }
  }

  protected actionClass(action: PermissionAction, active: boolean): string {
    const base =
      'flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors focus:outline-none';
    if (active) {
      return action.danger
        ? `${base} border-rose-400/50 bg-rose-500/15 text-rose-100`
        : `${base} border-accent/60 bg-accent/15 text-white`;
    }
    return action.danger
      ? `${base} border-transparent text-rose-300/80 hover:bg-rose-500/10`
      : `${base} border-transparent text-mist hover:bg-white/5`;
  }

  protected choiceClass(selected: boolean): string {
    const base =
      'flex w-full items-center gap-3 rounded-lg border px-3 py-1.5 text-left transition-colors';
    return selected
      ? `${base} border-accent/60 bg-accent/10`
      : `${base} border-white/10 hover:bg-white/5`;
  }

  protected ruleKey(rule: CommandRule | null): string {
    return JSON.stringify(rule ? [rule.kind, rule.value] : null);
  }

  protected toggleFolder(folder: string): void {
    this.selectedFolders.update((folders) =>
      folders.includes(folder) ? folders.filter((entry) => entry !== folder) : [...folders, folder],
    );
  }

  protected toggleHost(host: string): void {
    this.selectedHosts.update((hosts) =>
      hosts.includes(host) ? hosts.filter((entry) => entry !== host) : [...hosts, host],
    );
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

  /// The rules a remembering choice saves: one per asking part of a compound
  /// command, otherwise the single selected scope.
  private chosenRules(): CommandRule[] {
    const groups = this.segmentScopes();
    if (groups.length > 0) {
      // Parts that share a rule (two `kill` calls) remember it once.
      const rules: CommandRule[] = [];
      for (const group of groups) {
        const rule = this.selectedSegmentRule(group.index);
        if (rule && !rules.some((existing) => this.ruleKey(existing) === this.ruleKey(rule))) {
          rules.push(rule);
        }
      }
      return rules;
    }
    const single = this.selectedScopeRule();
    return single ? [single] : [];
  }

  /// Keyboard like Claude Code: 1–n picks a choice, arrows move, Enter
  /// confirms, Esc denies. Typing into a field is never intercepted.
  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || event.isComposing) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
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
    const actions = this.actions();
    if (/^[1-9]$/.test(event.key)) {
      const action = actions[Number(event.key) - 1];
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        this.run(action);
      }
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
      case 'Enter': {
        // Enter on a choice inside "Customize" selects that choice instead.
        const onCustomize =
          target?.tagName === 'BUTTON' &&
          !this.actionButtons().some((button) => button.nativeElement === target);
        if (onCustomize) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.activate();
        break;
      }
      case 'Escape': {
        // Only while the prompt has focus, so Esc in another open panel keeps
        // closing that panel.
        const inPrompt =
          !target ||
          target === document.body ||
          this.element.nativeElement.contains(target);
        const deny = actions.find((action) => action.id === 'deny');
        if (inPrompt && deny) {
          event.preventDefault();
          event.stopPropagation();
          this.run(deny);
        }
        break;
      }
    }
  }

  private move(delta: number): void {
    const count = this.actions().length;
    if (count === 0) {
      return;
    }
    const next = (this.active() + delta + count) % count;
    this.activeIndex.set(next);
    this.actionButtons()[next]?.nativeElement.focus();
  }

  private activate(): void {
    const action = this.actions()[this.active()];
    if (action) {
      this.run(action);
    }
  }

  protected onRuleInput(event: Event): void {
    this.rule.set((event.target as HTMLInputElement).value);
  }

  protected run(action: PermissionAction): void {
    const decision = action.decision;
    if (this.isWeb()) {
      if (decision === 'allow_once' || decision === 'deny') {
        void this.workspace.resolvePermission(decision);
        return;
      }
      void this.workspace.resolvePermission(decision, undefined, undefined, undefined, this.rule());
      return;
    }
    if (this.request().promptKind !== 'command') {
      void this.workspace.resolvePermission(decision);
      return;
    }
    switch (decision) {
      case 'allow_always':
      case 'allow_session':
        void this.workspace.resolvePermission(
          decision,
          this.chosenRules(),
          this.selectedFolders(),
          this.selectedHosts(),
        );
        return;
      case 'deny_always':
        void this.workspace.resolvePermission('deny_always', this.chosenRules(), [], []);
        return;
      default:
        void this.workspace.resolvePermission(decision);
    }
  }
}
