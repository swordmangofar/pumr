import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { FileChange, LiveToolCall, Message, Mode } from '../core/models';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';

type DebugKind =
  'context' | 'user' | 'assistant' | 'tool' | 'subagent' | 'question' | 'mcp' | 'skill' | 'error';
type DebugStatus = 'ok' | 'error' | 'running';

interface DebugField {
  labelKey: string;
  value: string;
  valueKey?: string;
  mono: boolean;
  tone: 'default' | 'muted' | 'accent' | 'ok' | 'error';
}

interface DebugSection {
  labelKey: string;
  text: string;
  mono: boolean;
}

interface DebugStep {
  id: string;
  kind: DebugKind;
  tags: DebugKind[];
  titleKey: string;
  subtitle: string;
  time: number | null;
  status: string | null;
  statusCategory?: DebugStatus | null;
  durationMs?: number | null;
  fields: DebugField[];
  sections: DebugSection[];
}

const DEBUG_KINDS: readonly DebugKind[] = [
  'context',
  'user',
  'assistant',
  'tool',
  'subagent',
  'question',
  'mcp',
  'skill',
  'error',
];
const DEBUG_STATUSES: readonly DebugStatus[] = ['ok', 'error', 'running'];

@Component({
  selector: 'app-debug-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  host: {
    '(document:keydown.escape)': 'close()',
  },
  template: `
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      (click)="close()"
    >
      <div
        class="flex h-[88vh] w-[80rem] max-w-full flex-col overflow-hidden glass-pop rounded-2xl shadow-2xl"
        (click)="$event.stopPropagation()"
      >
        <header class="flex shrink-0 items-center gap-3 border-b border-white/5 px-6 py-4">
          <span
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-4 w-4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m8 2 1.5 1.5M16 2l-1.5 1.5M9 7a3 3 0 0 1 6 0v3a3 3 0 0 1-6 0Z" />
              <path d="M12 13v8M8 21h8M3 8l3 1M3 13l3-1M21 8l-3 1M21 13l-3-1M6 17l-3 2M18 17l3 2" />
            </svg>
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="text-base font-semibold text-white">{{ 'debug.title' | transloco }}</h2>
            <p class="truncate text-xs text-mist/40">
              {{ session()?.title ?? ('debug.noSession' | transloco) }}
            </p>
          </div>
          @if (streaming()) {
            <span class="flex items-center gap-1.5 text-xs text-accent">
              <span class="h-2 w-2 animate-pulse rounded-full bg-accent"></span>
              {{ 'debug.live' | transloco }}
            </span>
          }
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-mist/50 transition-colors hover:bg-white/5 hover:text-white"
            [attr.aria-label]="'common.close' | transloco"
            (click)="close()"
          >
            ✕
          </button>
        </header>

        @if (session(); as active) {
          <div
            class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/5 px-6 py-2 text-xs text-mist/50"
          >
            @if (active.model) {
              <span>{{ active.model }}</span>
            }
            @if (active.provider) {
              <span>{{ active.provider }}</span>
            }
            @if (mode(); as selectedMode) {
              <span>{{ 'debug.summary.mode' | transloco }}: {{ selectedMode.name }}</span>
            }
            @if (active.reasoningEffort) {
              <span>{{ 'debug.summary.reasoning' | transloco }}: {{ active.reasoningEffort }}</span>
            }
            <span>{{ 'debug.summary.messages' | transloco }}: {{ messages().length }}</span>
            <span
              >{{ 'debug.summary.tokens' | transloco }}: {{ active.promptTokens }}→{{
                active.completionTokens
              }}</span
            >
            @if (active.cost > 0) {
              <span>{{ 'debug.summary.cost' | transloco }}: {{ money(active.cost) }}</span>
            }
          </div>

          <div
            class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-white/5 px-6 py-2"
          >
            <span class="mr-1 text-[10px] font-semibold tracking-wider uppercase text-mist/30">
              {{ 'debug.filters.type' | transloco }}
            </span>
            @for (kind of kinds; track kind) {
              <button
                type="button"
                class="rounded-full px-2.5 py-0.5 text-xs transition-colors"
                [class]="
                  typeFilter().has(kind)
                    ? 'bg-accent/20 text-white ring-1 ring-accent/40 ring-inset'
                    : 'bg-white/5 text-mist/50 hover:text-mist'
                "
                (click)="toggleType(kind)"
              >
                {{ 'debug.kinds.' + kind | transloco }}
              </button>
            }

            <span class="mx-1.5 h-4 w-px bg-white/10"></span>

            <span class="mr-1 text-[10px] font-semibold tracking-wider uppercase text-mist/30">
              {{ 'debug.filters.status' | transloco }}
            </span>
            @for (status of statuses; track status) {
              <button
                type="button"
                class="rounded-full px-2.5 py-0.5 text-xs transition-colors"
                [class]="
                  statusFilter().has(status)
                    ? 'bg-accent/20 text-white ring-1 ring-accent/40 ring-inset'
                    : 'bg-white/5 text-mist/50 hover:text-mist'
                "
                (click)="toggleStatus(status)"
              >
                {{ 'debug.status.' + status | transloco }}
              </button>
            }

            <span class="ml-auto text-[10px] tabular-nums text-mist/30">
              {{ filteredSteps().length }} / {{ steps().length }}
            </span>
            @if (hasFilters()) {
              <button
                type="button"
                class="rounded-full px-2.5 py-0.5 text-xs text-mist/40 transition-colors hover:text-mist"
                (click)="clearFilters()"
              >
                {{ 'debug.filters.clear' | transloco }}
              </button>
            }
          </div>

          <div class="flex min-h-0 flex-1 flex-col">
            <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              @if (steps().length === 0) {
                <div class="flex h-full items-center justify-center text-sm text-mist/40">
                  {{ 'debug.empty' | transloco }}
                </div>
              } @else if (filteredSteps().length === 0) {
                <div class="flex h-full items-center justify-center text-sm text-mist/40">
                  {{ 'debug.noMatches' | transloco }}
                </div>
              } @else {
                <ol class="relative ml-1 border-l border-white/10">
                  @for (step of filteredSteps(); track step.id) {
                    <li class="relative pl-5 pb-1">
                      <span
                        class="absolute top-3.5 left-0 h-2.5 w-2.5 -translate-x-1/2 rounded-full ring-2 ring-navy"
                        [class]="nodeClass(step.kind)"
                      ></span>
                      <button
                        type="button"
                        class="w-full rounded-xl px-3 py-2 text-left transition-colors"
                        [class]="
                          step.id === selectedId()
                            ? 'bg-accent/10 ring-1 ring-accent/30 ring-inset'
                            : 'hover:bg-white/5'
                        "
                        (click)="select(step.id)"
                      >
                        <div class="flex items-center gap-2">
                          <span
                            class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase"
                            [class]="badgeClass(step.kind)"
                          >
                            {{ 'debug.kinds.' + step.kind | transloco }}
                          </span>
                          @for (tag of secondaryTags(step); track tag) {
                            <span
                              class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase"
                              [class]="badgeClass(tag)"
                            >
                              {{ 'debug.kinds.' + tag | transloco }}
                            </span>
                          }
                          <span class="min-w-0 flex-1 truncate text-sm text-mist">
                            {{ step.titleKey | transloco }}
                          </span>
                          @if (step.status; as status) {
                            <span
                              class="shrink-0 text-[10px] font-medium"
                              [class]="statusClass(status)"
                            >
                              {{ status }}
                            </span>
                          }
                          @if (step.durationMs) {
                            <span class="shrink-0 text-[10px] tabular-nums text-accent/70">
                              {{ formatDuration(step.durationMs) }}
                            </span>
                          }
                          @if (step.time !== null) {
                            <span class="shrink-0 text-[10px] tabular-nums text-mist/30">
                              {{ formatTime(step.time) }}
                            </span>
                          }
                        </div>
                        @if (step.subtitle) {
                          <div class="mt-0.5 truncate font-mono text-xs text-mist/40">
                            {{ step.subtitle }}
                          </div>
                        }
                      </button>
                    </li>
                  }
                </ol>
              }
            </div>

            <div
              class="max-h-[46%] min-h-48 shrink-0 overflow-y-auto border-t border-white/10 bg-ink/30 px-6 py-4"
            >
              @if (selectedStep(); as step) {
                <div class="mb-3 flex items-center gap-2">
                  <span
                    class="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase"
                    [class]="badgeClass(step.kind)"
                  >
                    {{ 'debug.kinds.' + step.kind | transloco }}
                  </span>
                  <h3 class="min-w-0 flex-1 truncate text-sm font-semibold text-white">
                    {{ step.titleKey | transloco }}
                  </h3>
                  @if (step.durationMs) {
                    <span class="text-xs tabular-nums text-accent">
                      {{ formatDuration(step.durationMs) }}
                    </span>
                  }
                  @if (step.time !== null) {
                    <span class="text-xs tabular-nums text-mist/40">{{
                      formatTime(step.time)
                    }}</span>
                  }
                </div>

                @if (step.fields.length > 0) {
                  <dl
                    class="grid grid-cols-[minmax(7rem,9rem)_1fr] gap-x-4 gap-y-1.5 border-t border-white/5 pt-3 text-xs"
                  >
                    @for (field of step.fields; track $index) {
                      <dt class="text-mist/40">{{ field.labelKey | transloco }}</dt>
                      <dd class="min-w-0 break-words" [class]="fieldClass(field)">
                        {{ field.valueKey ? (field.valueKey | transloco) : field.value }}
                      </dd>
                    }
                  </dl>
                }

                @for (section of step.sections; track $index) {
                  @if (section.text) {
                    <div class="mt-4">
                      <div
                        class="mb-1.5 text-[10px] font-semibold tracking-wider uppercase text-mist/30"
                      >
                        {{ section.labelKey | transloco }}
                      </div>
                      <pre
                        class="max-h-80 overflow-auto rounded-xl border border-white/10 bg-ink/60 px-4 py-3 text-xs leading-relaxed break-words whitespace-pre-wrap text-mist/70"
                        [class.font-mono]="section.mono"
                        >{{ section.text }}</pre>
                    </div>
                  }
                }
              } @else {
                <div class="flex h-full items-center justify-center text-sm text-mist/40">
                  {{ 'debug.selectStep' | transloco }}
                </div>
              }
            </div>
          </div>
        } @else {
          <div class="flex flex-1 items-center justify-center text-sm text-mist/40">
            {{ 'debug.noSession' | transloco }}
          </div>
        }
      </div>
    </div>
  `,
})
export class DebugView {
  private readonly workspace = inject(WorkspaceService);
  private readonly settings = inject(SettingsService);

  protected readonly selectedId = signal<string | null>(null);
  protected readonly typeFilter = signal<ReadonlySet<DebugKind>>(new Set());
  protected readonly statusFilter = signal<ReadonlySet<DebugStatus>>(new Set());
  protected readonly kinds = DEBUG_KINDS;
  protected readonly statuses = DEBUG_STATUSES;

  protected readonly session = computed(() => {
    const id = this.workspace.debugSessionId();
    return id ? this.workspace.session(id) : null;
  });
  protected readonly messages = computed(() => {
    const session = this.session();
    return session ? this.workspace.messagesFor(session.id) : [];
  });
  protected readonly liveTools = computed(() => {
    const session = this.session();
    return session ? this.workspace.liveToolsFor(session.id) : [];
  });
  protected readonly streaming = computed(() => {
    const session = this.session();
    return session ? this.workspace.isStreaming(session.id) : false;
  });
  protected readonly mode = computed<Mode | null>(() => {
    const settings = this.settings.settings();
    if (!settings) {
      return null;
    }
    const id = this.session()?.modeId ?? settings.defaultModeId;
    return settings.modes.find((entry) => entry.id === id) ?? null;
  });

  protected readonly steps = computed<DebugStep[]>(() => {
    const session = this.session();
    if (!session) {
      return [];
    }
    const settings = this.settings.settings();
    const mode = this.mode();
    const steps: DebugStep[] = [];

    const systemPrompt = (
      session.systemPrompt?.trim() ||
      settings?.defaultSystemPrompt ||
      ''
    ).trim();
    if (systemPrompt) {
      steps.push({
        id: 'context:system',
        kind: 'context',
        tags: ['context'],
        titleKey: 'debug.steps.systemPrompt',
        subtitle: firstLine(systemPrompt),
        time: null,
        status: null,
        fields: [
          {
            labelKey: 'debug.fields.source',
            value: '',
            valueKey: session.systemPrompt?.trim()
              ? 'debug.sources.session'
              : 'debug.sources.default',
            mono: false,
            tone: 'muted',
          },
          charField(systemPrompt),
        ],
        sections: [{ labelKey: 'debug.sections.systemPrompt', text: systemPrompt, mono: false }],
      });
    }

    if (mode?.includeGlobalPrompts && settings) {
      const globals: string[] = [];
      for (const [enabled, prompt] of [
        [settings.securitySystemPromptEnabled, settings.securitySystemPrompt],
        [settings.testingSystemPromptEnabled, settings.testingSystemPrompt],
        [settings.architectureSystemPromptEnabled, settings.architectureSystemPrompt],
      ] as [boolean, string][]) {
        if (enabled && prompt.trim()) {
          globals.push(prompt);
        }
      }
      for (const prompt of settings.userSystemPrompts) {
        if (prompt.enabled && prompt.prompt.trim()) {
          globals.push(prompt.prompt);
        }
      }
      if (globals.length > 0) {
        steps.push({
          id: 'context:globals',
          kind: 'context',
          tags: ['context'],
          titleKey: 'debug.steps.globalPrompts',
          subtitle: '',
          time: null,
          status: null,
          fields: [
            {
              labelKey: 'debug.fields.count',
              value: String(globals.length),
              mono: true,
              tone: 'default',
            },
            charField(globals.join('\n\n')),
          ],
          sections: [
            { labelKey: 'debug.sections.globalPrompts', text: globals.join('\n\n'), mono: false },
          ],
        });
      }
    }

    if (mode) {
      const modeFields: DebugField[] = [
        { labelKey: 'debug.fields.mode', value: mode.name, mono: false, tone: 'default' },
        {
          labelKey: 'debug.fields.planOnly',
          value: String(mode.planOnly),
          mono: true,
          tone: 'muted',
        },
      ];
      if (mode.skills.length > 0) {
        modeFields.push({
          labelKey: 'debug.fields.skills',
          value: mode.skills.join(', '),
          mono: true,
          tone: 'muted',
        });
      }
      if (mode.mcpServers.length > 0) {
        modeFields.push({
          labelKey: 'debug.fields.mcpServers',
          value: mode.mcpServers.join(', '),
          mono: true,
          tone: 'muted',
        });
      }
      const modeTags: DebugKind[] = ['context'];
      if (mode.skills.length > 0) {
        modeTags.push('skill');
      }
      if (mode.mcpServers.length > 0) {
        modeTags.push('mcp');
      }
      steps.push({
        id: 'context:mode',
        kind: 'context',
        tags: modeTags,
        titleKey: 'debug.steps.mode',
        subtitle: mode.description,
        time: null,
        status: null,
        fields: modeFields,
        sections: mode.systemPrompt.trim()
          ? [{ labelKey: 'debug.sections.mode', text: mode.systemPrompt, mono: false }]
          : [],
      });
    }

    const rules = this.workspace.rules();
    if (rules.length > 0) {
      const text = rules
        .map((rule) => `## ${rule.scope} (${rule.path})\n${rule.content}`)
        .join('\n\n');
      steps.push({
        id: 'context:rules',
        kind: 'context',
        tags: ['context'],
        titleKey: 'debug.steps.projectRules',
        subtitle: rules.map((rule) => rule.path).join(', '),
        time: null,
        status: null,
        fields: [
          {
            labelKey: 'debug.fields.count',
            value: String(rules.length),
            mono: true,
            tone: 'default',
          },
        ],
        sections: [{ labelKey: 'debug.sections.projectRules', text, mono: false }],
      });
    }

    const calls = new Map<string, { name: string; arguments: string }>();
    for (const message of this.messages()) {
      for (const call of message.toolCalls) {
        calls.set(call.id, { name: call.name, arguments: call.arguments });
      }
    }

    const seenTools = new Set<string>();
    for (const message of this.messages()) {
      steps.push(this.messageStep(message, calls, seenTools));
    }

    for (const tool of this.liveTools()) {
      if (seenTools.has(tool.callId)) {
        continue;
      }
      seenTools.add(tool.callId);
      steps.push(this.liveToolStep(tool));
    }

    const error = this.workspace.errorFor(session.id);
    if (error) {
      steps.push({
        id: 'error',
        kind: 'error',
        tags: ['error'],
        titleKey: 'debug.steps.error',
        subtitle: firstLine(error),
        time: null,
        status: 'error',
        fields: [],
        sections: [{ labelKey: 'debug.sections.error', text: error, mono: true }],
      });
    }

    return steps;
  });

  protected readonly filteredSteps = computed(() => {
    const types = this.typeFilter();
    const statuses = this.statusFilter();
    if (types.size === 0 && statuses.size === 0) {
      return this.steps();
    }
    return this.steps().filter((step) => {
      if (types.size > 0 && !step.tags.some((tag) => types.has(tag))) {
        return false;
      }
      if (statuses.size > 0) {
        const category = step.statusCategory ?? statusCategoryOf(step.status);
        return category !== null && statuses.has(category);
      }
      return true;
    });
  });

  protected readonly hasFilters = computed(
    () => this.typeFilter().size > 0 || this.statusFilter().size > 0,
  );

  protected readonly selectedStep = computed(() => {
    const id = this.selectedId();
    return id ? (this.steps().find((step) => step.id === id) ?? null) : null;
  });

  constructor() {
    effect(() => {
      const steps = this.filteredSteps();
      const current = untracked(this.selectedId);
      if (steps.length === 0) {
        return;
      }
      if (!current || !steps.some((step) => step.id === current)) {
        this.selectedId.set(steps[steps.length - 1].id);
      }
    });
  }

  protected close(): void {
    this.workspace.closeDebug();
  }

  protected select(id: string): void {
    this.selectedId.set(id);
  }

  protected toggleType(kind: DebugKind): void {
    this.typeFilter.update((set) => toggleSet(set, kind));
  }

  protected toggleStatus(status: DebugStatus): void {
    this.statusFilter.update((set) => toggleSet(set, status));
  }

  protected clearFilters(): void {
    this.typeFilter.set(new Set());
    this.statusFilter.set(new Set());
  }

  protected formatTime(time: number): string {
    return new Date(time).toLocaleTimeString();
  }

  protected formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms} ms`;
    }
    if (ms < 60_000) {
      return `${(ms / 1000).toFixed(1)} s`;
    }
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  protected money(value: number): string {
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  }

  protected secondaryTags(step: DebugStep): DebugKind[] {
    return step.tags.filter((tag) => tag !== step.kind && (tag === 'skill' || tag === 'mcp'));
  }

  protected nodeClass(kind: DebugKind): string {
    switch (kind) {
      case 'context':
        return 'bg-sky-400';
      case 'user':
        return 'bg-accent';
      case 'assistant':
        return 'bg-violet-400';
      case 'tool':
        return 'bg-emerald-400';
      case 'subagent':
        return 'bg-amber-400';
      case 'question':
        return 'bg-fuchsia-400';
      case 'mcp':
        return 'bg-cyan-400';
      case 'skill':
        return 'bg-teal-400';
      case 'error':
        return 'bg-rose-500';
    }
  }

  protected badgeClass(kind: DebugKind): string {
    switch (kind) {
      case 'context':
        return 'bg-sky-500/15 text-sky-300';
      case 'user':
        return 'bg-accent/15 text-accent';
      case 'assistant':
        return 'bg-violet-500/15 text-violet-300';
      case 'tool':
        return 'bg-emerald-500/15 text-emerald-300';
      case 'subagent':
        return 'bg-amber-500/15 text-amber-300';
      case 'question':
        return 'bg-fuchsia-500/15 text-fuchsia-300';
      case 'mcp':
        return 'bg-cyan-500/15 text-cyan-300';
      case 'skill':
        return 'bg-teal-500/15 text-teal-300';
      case 'error':
        return 'bg-rose-500/15 text-rose-300';
    }
  }

  protected statusClass(status: string): string {
    switch (status) {
      case 'error':
        return 'text-rose-400';
      case 'running':
        return 'text-accent';
      case 'denied':
      case 'canceled':
        return 'text-mist/40';
      default:
        return 'text-emerald-400';
    }
  }

  protected fieldClass(field: DebugField): string {
    const mono = field.mono ? 'font-mono ' : '';
    switch (field.tone) {
      case 'accent':
        return `${mono}text-accent`;
      case 'ok':
        return `${mono}text-emerald-400`;
      case 'error':
        return `${mono}text-rose-400`;
      case 'muted':
        return `${mono}text-mist/50`;
      default:
        return `${mono}text-mist`;
    }
  }

  private messageStep(
    message: Message,
    calls: Map<string, { name: string; arguments: string }>,
    seenTools: Set<string>,
  ): DebugStep {
    if (message.role === 'user') {
      const fields: DebugField[] = [
        {
          labelKey: 'debug.fields.time',
          value: this.formatTime(message.createdAt),
          mono: true,
          tone: 'muted',
        },
      ];
      if (message.mentions.length > 0) {
        fields.push({
          labelKey: 'debug.fields.mentions',
          value: String(message.mentions.length),
          mono: true,
          tone: 'default',
        });
      }
      if (message.attachments.length > 0) {
        fields.push({
          labelKey: 'debug.fields.attachments',
          value: String(message.attachments.length),
          mono: true,
          tone: 'default',
        });
      }
      if (message.context.trim()) {
        fields.push(charField(message.context));
      }
      const sections: DebugSection[] = [
        { labelKey: 'debug.sections.prompt', text: message.content, mono: false },
      ];
      if (message.context.trim()) {
        sections.push({
          labelKey: 'debug.sections.referencedContext',
          text: message.context,
          mono: false,
        });
      }
      if (message.mentions.length > 0) {
        sections.push({
          labelKey: 'debug.sections.mentions',
          text: message.mentions.map((m) => `${m.kind}: ${m.value}`).join('\n'),
          mono: true,
        });
      }
      if (message.attachments.length > 0) {
        sections.push({
          labelKey: 'debug.sections.attachments',
          text: message.attachments.map((a) => `${a.name} (${a.mimeType}, ${a.size} B)`).join('\n'),
          mono: true,
        });
      }
      const tags: DebugKind[] = ['user'];
      if (message.mentions.some((mention) => mention.kind === 'skill')) {
        tags.push('skill');
      }
      if (message.mentions.some((mention) => mention.kind === 'mcp')) {
        tags.push('mcp');
      }
      return {
        id: message.id,
        kind: 'user',
        tags,
        titleKey: 'debug.steps.user',
        subtitle: firstLine(message.content),
        time: message.createdAt,
        status: null,
        fields,
        sections,
      };
    }

    if (message.role === 'assistant') {
      const fields: DebugField[] = [];
      if (message.model) {
        fields.push({
          labelKey: 'debug.fields.model',
          value: message.model,
          mono: true,
          tone: 'default',
        });
      }
      if (message.provider) {
        fields.push({
          labelKey: 'debug.fields.provider',
          value: message.provider,
          mono: true,
          tone: 'muted',
        });
      }
      if (message.promptTokens > 0) {
        fields.push({
          labelKey: 'debug.fields.promptTokens',
          value: String(message.promptTokens),
          mono: true,
          tone: 'default',
        });
        fields.push({
          labelKey: 'debug.fields.completionTokens',
          value: String(message.completionTokens),
          mono: true,
          tone: 'default',
        });
      }
      if (message.cachedTokens > 0) {
        fields.push({
          labelKey: 'debug.fields.cachedTokens',
          value: String(message.cachedTokens),
          mono: true,
          tone: 'default',
        });
      }
      if (message.cost > 0) {
        fields.push({
          labelKey: 'debug.fields.cost',
          value: this.money(message.cost),
          mono: true,
          tone: 'default',
        });
      }
      if (message.toolCalls.length > 0) {
        fields.push({
          labelKey: 'debug.fields.toolCalls',
          value: message.toolCalls.map((call) => call.name).join(', '),
          mono: true,
          tone: 'accent',
        });
      }
      if (message.durationMs > 0) {
        fields.push({
          labelKey: 'debug.fields.duration',
          value: this.formatDuration(message.durationMs),
          mono: true,
          tone: 'accent',
        });
      }
      const sections: DebugSection[] = [];
      if (message.reasoning.trim()) {
        sections.push({
          labelKey: 'debug.sections.reasoning',
          text: message.reasoning,
          mono: false,
        });
      }
      if (message.content.trim()) {
        sections.push({ labelKey: 'debug.sections.content', text: message.content, mono: false });
      }
      const messages = this.messages();
      const isLast = messages[messages.length - 1]?.id === message.id;
      const running = this.streaming() && isLast && !message.content;
      return {
        id: message.id,
        kind: 'assistant',
        tags: ['assistant'],
        titleKey: 'debug.steps.assistant',
        subtitle: firstLine(message.reasoning || message.content),
        time: message.createdAt,
        status: message.status,
        statusCategory: message.status === 'error' ? 'error' : running ? 'running' : 'ok',
        durationMs: message.durationMs > 0 ? message.durationMs : null,
        fields,
        sections,
      };
    }

    if (message.role === 'tool') {
      const callId = message.toolCallId ?? message.id;
      seenTools.add(callId);
      const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      return this.toolStep({
        id: message.id,
        callId,
        name: message.toolName ?? call?.name ?? 'tool',
        arguments: call?.arguments ?? '',
        output: message.content,
        status: message.status ?? 'ok',
        changes: message.changes,
        time: message.createdAt,
        durationMs: message.durationMs > 0 ? message.durationMs : null,
      });
    }

    return {
      id: message.id,
      kind: 'context',
      tags: ['context'],
      titleKey: 'debug.steps.systemMessage',
      subtitle: firstLine(message.content),
      time: message.createdAt,
      status: null,
      fields: [],
      sections: [{ labelKey: 'debug.sections.content', text: message.content, mono: false }],
    };
  }

  private liveToolStep(tool: LiveToolCall): DebugStep {
    return this.toolStep({
      id: tool.callId,
      callId: tool.callId,
      name: tool.name,
      arguments: tool.arguments,
      output: tool.output,
      status: tool.status,
      changes: tool.changes,
      time: null,
      durationMs: null,
    });
  }

  private toolStep(input: {
    id: string;
    callId: string;
    name: string;
    arguments: string;
    output: string;
    status: string;
    changes: FileChange[];
    time: number | null;
    durationMs: number | null;
  }): DebugStep {
    const fields: DebugField[] = [
      { labelKey: 'debug.fields.tool', value: input.name, mono: true, tone: 'accent' },
      {
        labelKey: 'debug.fields.status',
        value: input.status,
        mono: true,
        tone: input.status === 'error' ? 'error' : 'ok',
      },
      { labelKey: 'debug.fields.callId', value: input.callId, mono: true, tone: 'muted' },
    ];
    if (input.time !== null) {
      fields.push({
        labelKey: 'debug.fields.time',
        value: this.formatTime(input.time),
        mono: true,
        tone: 'muted',
      });
    }
    if (input.durationMs !== null) {
      fields.push({
        labelKey: 'debug.fields.duration',
        value: this.formatDuration(input.durationMs),
        mono: true,
        tone: 'accent',
      });
    }
    if (input.changes.length > 0) {
      fields.push({
        labelKey: 'debug.fields.changes',
        value: String(input.changes.length),
        mono: true,
        tone: 'default',
      });
    }
    const sections: DebugSection[] = [
      { labelKey: 'debug.sections.arguments', text: prettyJson(input.arguments), mono: true },
      { labelKey: 'debug.sections.output', text: input.output, mono: true },
    ];
    if (input.changes.length > 0) {
      sections.push({
        labelKey: 'debug.sections.changes',
        text: input.changes
          .map(
            (change) =>
              `${change.status} ${change.path} (+${change.additions} -${change.deletions})`,
          )
          .join('\n'),
        mono: true,
      });
    }
    const isTask = input.name === 'task';
    const isQuestion = input.name === 'question';
    const isMcp = input.name.startsWith('mcp__');
    const kind: DebugKind = isTask ? 'subagent' : isQuestion ? 'question' : isMcp ? 'mcp' : 'tool';
    const tags: DebugKind[] = ['tool'];
    if (isTask) {
      tags.push('subagent');
    }
    if (isQuestion) {
      tags.push('question');
    }
    if (isMcp) {
      tags.push('mcp');
    }
    const titleKey = isTask
      ? 'debug.steps.subagent'
      : isQuestion
        ? 'debug.steps.question'
        : isMcp
          ? 'debug.steps.mcp'
          : 'debug.steps.tool';
    return {
      id: input.id,
      kind,
      tags,
      titleKey,
      subtitle: input.name,
      time: input.time,
      status: input.status,
      statusCategory: statusCategoryOf(input.status),
      durationMs: input.durationMs,
      fields,
      sections,
    };
  }
}

function statusCategoryOf(status: string | null): DebugStatus | null {
  if (!status) {
    return null;
  }
  if (status === 'running') {
    return 'running';
  }
  if (status === 'error' || status === 'denied' || status === 'canceled') {
    return 'error';
  }
  return 'ok';
}

function toggleSet<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim().length > 0) ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function charField(text: string): DebugField {
  return {
    labelKey: 'debug.fields.characters',
    value: String(text.length),
    mono: true,
    tone: 'muted',
  };
}

function prettyJson(value: string): string {
  if (!value.trim()) {
    return '';
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
