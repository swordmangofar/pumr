import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { FileChange, LiveToolCall, Message, MessageAttachment } from '../core/models';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { Composer } from './composer';
import { AgentStatus } from './agent-status';
import { PermissionOverlay } from './permission-overlay';
import { PumaLoader } from './puma-loader';
import { ProjectIcon } from './project-icon';
import { QuestionOverlay } from './question-overlay';
import { StreamText } from './stream-text';
import { ToolCard } from './tool-card';
import { ToolGroup, ToolGroupItem } from './tool-group';

interface MessageEntry {
  kind: 'message';
  key: string;
  message: Message;
}

interface ToolEntry {
  kind: 'tool';
  key: string;
  name: string;
  summary: string;
  command: string;
  output: string;
  status: string;
  changes: FileChange[];
}

interface ToolGroupEntry {
  kind: 'toolGroup';
  key: string;
  name: string;
  items: ToolGroupItem[];
}

type ChatEntry = MessageEntry | ToolEntry | ToolGroupEntry;

const HIDDEN_TOOLS = new Set(['ls']);
const GROUPABLE_TOOLS = new Set(['read', 'write', 'edit', 'bash']);

@Component({
  selector: 'app-chat-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TranslocoPipe,
    Composer,
    PermissionOverlay,
    QuestionOverlay,
    ToolCard,
    ToolGroup,
    AgentStatus,
    PumaLoader,
    StreamText,
    ProjectIcon,
  ],
  template: `
    <div class="flex h-full min-h-0 flex-col">
      @if (tauri && !settings.hasApiKey()) {
        <div
          class="flex items-center justify-between gap-3 border-b border-accent/25 bg-accent/10 px-5 py-2.5 text-sm text-accent"
        >
          <span>{{ 'chat.noKey' | transloco }}</span>
          <button
            type="button"
            class="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-3.5 py-1 text-sm font-medium text-accent hover:bg-accent/20"
            (click)="settings.open('providers', 'apiKey')"
          >
            {{ 'chat.openSettings' | transloco }}
          </button>
        </div>
      }

      @if (session(); as active) {
        <div class="relative min-h-0 flex-1">
          <div #scroll class="h-full overflow-y-auto" (scroll)="onScroll()">
            <div class="mx-auto w-full max-w-4xl px-6 py-6">
              @if (
                messages().length === 0 &&
                liveTools().length === 0 &&
                !composing() &&
                !viewingSubAgent()
              ) {
                <div class="flex flex-col items-center gap-3 py-24">
                  <span class="text-xs font-semibold uppercase tracking-widest text-mist/40">
                    {{ 'tabs.selectProject' | transloco }}
                  </span>
                  <div class="relative">
                    <button
                      type="button"
                      class="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white transition-colors hover:border-accent/40 hover:bg-accent/10"
                      (click)="toggleProjectMenu()"
                    >
                      @if (workspace.activeProject(); as project) {
                        <app-project-icon [project]="project" [size]="24" />
                      }
                      <span>{{ workspace.activeProject()?.name }}</span>
                      <svg
                        class="h-3.5 w-3.5 text-mist/40"
                        viewBox="0 0 20 20"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M5 7.5 10 12.5 15 7.5"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        />
                      </svg>
                    </button>

                    @if (projectOpen()) {
                      <div class="fixed inset-0 z-30" (click)="projectOpen.set(false)"></div>
                      <div
                        class="absolute top-full left-1/2 z-40 mt-2 max-h-[min(20rem,50vh)] w-80 max-w-[80vw] -translate-x-1/2 overflow-y-auto glass-pop rounded-2xl shadow-2xl"
                      >
                        @for (project of workspace.projects(); track project.id) {
                          <button
                            type="button"
                            class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors"
                            [class]="
                              project.id === workspace.activeProject()?.id
                                ? 'bg-accent/10'
                                : 'hover:bg-white/5'
                            "
                            (click)="selectProject(project.id)"
                          >
                            <app-project-icon [project]="project" [size]="34" radius="rounded-lg" />
                            <span class="min-w-0 flex-1">
                              <span class="block truncate text-sm text-white">{{
                                project.name
                              }}</span>
                              <span class="block truncate text-xs text-mist/40">{{
                                project.path
                              }}</span>
                            </span>
                            @if (gitFor(project.id); as git) {
                              @if (git.isRepo && git.branch) {
                                <span
                                  class="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-mist/60"
                                >
                                  ⎇ {{ git.branch }}
                                </span>
                              }
                            }
                          </button>
                        }
                      </div>
                    }
                  </div>

                  @if (workspace.activeGitInfo()?.branch; as branch) {
                    <span
                      class="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs text-mist/60"
                    >
                      ⎇ {{ branch }}
                    </span>
                  }
                </div>
              }

              @for (entry of timeline(); track entry.key) {
                @if (entry.kind === 'message') {
                  <div
                    class="mb-6 scroll-mt-6"
                    [attr.id]="entryAnchor(entry)"
                    [class.msg-flash]="highlightId() === entry.message.id"
                  >
                    @switch (entry.message.role) {
                      @case ('user') {
                        <div class="group flex items-start justify-end gap-2">
                          <app-puma-loader [compact]="true" [pose]="'sit'" class="mt-1 shrink-0" />
                          <button
                            type="button"
                            class="mt-2 flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-mist/60 opacity-0 transition group-hover:opacity-100 hover:border-accent/40 hover:bg-accent/15 hover:text-accent"
                            [title]="'chat.revert' | transloco"
                            (click)="revertTarget.set(entry.message)"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              class="h-4 w-4"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                              <path d="M3 3v5h5" />
                            </svg>
                          </button>
                          <div
                            class="max-w-[85%] rounded-2xl rounded-tr-md border border-accent/25 bg-accent/10 px-4 py-3 text-[15px] whitespace-pre-wrap text-white"
                          >
                            @if (entry.message.attachments.length > 0) {
                              <div
                                class="mb-2 flex flex-wrap gap-2"
                                [class.mb-0]="!entry.message.content"
                              >
                                @for (
                                  attachment of entry.message.attachments;
                                  track attachment.id
                                ) {
                                  @if (attachment.kind === 'image') {
                                    <img
                                      [src]="attachmentPreview(attachment)"
                                      [alt]="attachment.name"
                                      class="h-28 w-28 rounded-lg border border-white/10 object-cover"
                                    />
                                  } @else {
                                    <span
                                      class="flex min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1"
                                    >
                                      @if (attachment.kind === 'pdf') {
                                        <span
                                          class="shrink-0 rounded bg-rose-500/15 px-1 py-0.5 text-[10px] font-semibold tracking-wide text-rose-300"
                                          >PDF</span
                                        >
                                      }
                                      <span class="max-w-48 truncate text-xs text-white">{{
                                        attachment.name
                                      }}</span>
                                      <span class="shrink-0 text-[11px] text-mist/50">
                                        {{ formatSize(attachment.size) }}
                                        @if (attachment.lines !== null) {
                                          · {{ attachment.lines }} ln
                                        }
                                      </span>
                                    </span>
                                  }
                                }
                              </div>
                            }
                            @if (entry.message.mentions.length > 0) {
                              <div
                                class="mb-2 flex flex-wrap gap-2"
                                [class.mb-0]="
                                  !entry.message.content && entry.message.attachments.length === 0
                                "
                              >
                                @for (
                                  mention of entry.message.mentions;
                                  track mention.kind + ':' + mention.value
                                ) {
                                  <span
                                    class="flex min-w-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs"
                                  >
                                    <span class="shrink-0 font-medium text-accent">{{
                                      mention.kind
                                    }}</span>
                                    <span class="max-w-56 truncate text-mist/70">{{
                                      mention.value
                                    }}</span>
                                  </span>
                                }
                              </div>
                            }
                            {{ entry.message.content }}
                          </div>
                        </div>
                      }
                      @default {
                        <div>
                          @if (entry.message.reasoning || isThinking(entry.message)) {
                            <details class="glass-inset mb-3 rounded-xl">
                              <summary
                                class="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm text-mist/50 select-none hover:text-mist"
                              >
                                @if (streaming() && isLast(entry.message)) {
                                  <app-puma-loader [compact]="true" />
                                  {{ 'chat.thinking' | transloco }}…
                                } @else {
                                  {{ 'chat.thinkingProcess' | transloco }}
                                }
                              </summary>
                              @if (entry.message.reasoning) {
                                <div
                                  class="max-h-80 overflow-y-auto border-t border-white/5 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap text-mist/60"
                                >
                                  <app-stream-text [content]="entry.message.reasoning" />
                                </div>
                              }
                            </details>
                          }

                          @if (entry.message.content) {
                            <div class="text-[15px] leading-relaxed whitespace-pre-wrap text-mist">
                              <app-stream-text [content]="entry.message.content" />
                              @if (streaming() && isLast(entry.message)) {
                                <span
                                  class="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-text-bottom"
                                ></span>
                              }
                            </div>
                          }

                          @if (entry.message.content || entry.message.cost > 0) {
                            <div
                              class="mt-2 flex flex-wrap items-center gap-3 text-xs text-mist/30"
                            >
                              @if (entry.message.model) {
                                <span>{{ shortModel(entry.message.model) }}</span>
                              }
                              @if (entry.message.cost > 0) {
                                <span
                                  >{{ 'chat.cost' | transloco }}
                                  {{ money(entry.message.cost) }}</span
                                >
                              }
                              @if (entry.message.promptTokens > 0) {
                                <span>
                                  {{ entry.message.promptTokens }}→{{
                                    entry.message.completionTokens
                                  }}
                                  {{ 'chat.tokens' | transloco }}
                                </span>
                              }
                              @if (entry.message.cachedTokens > 0) {
                                <span
                                  >{{ 'chat.cache' | transloco }}
                                  {{ cacheRate(entry.message) }}%</span
                                >
                              }
                            </div>
                          }
                        </div>
                      }
                    }
                  </div>
                } @else if (entry.kind === 'toolGroup') {
                  <app-tool-group
                    [name]="entry.name"
                    [items]="entry.items"
                    [sessionId]="active.id"
                  />
                } @else {
                  <app-tool-card
                    [name]="entry.name"
                    [summary]="entry.summary"
                    [command]="entry.command"
                    [output]="entry.output"
                    [status]="entry.status"
                    [changes]="entry.changes"
                    [sessionId]="active.id"
                  />
                }
              }

              @if (streaming() && waiting()) {
                <div class="mb-6 flex items-center gap-2 text-sm text-mist/50">
                  <app-puma-loader [compact]="true" />
                  {{ 'chat.thinking' | transloco }}…
                </div>
              }

              @if (error(); as err) {
                <div
                  class="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300"
                >
                  {{ 'chat.error' | transloco }}: {{ err }}
                </div>
              }
            </div>
          </div>

          @if (!atBottom()) {
            <button
              type="button"
              class="absolute bottom-4 left-1/2 z-10 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-white/15 bg-navy/90 text-lg text-mist shadow-lg backdrop-blur transition-colors hover:border-accent/60 hover:text-white"
              [title]="'chat.scrollToBottom' | transloco"
              [attr.aria-label]="'chat.scrollToBottom' | transloco"
              (click)="scrollToBottom(true)"
            >
              ↓
            </button>
          }
        </div>

        @if (subAgents().length > 0) {
          <div class="flex flex-wrap items-center gap-2 border-t border-white/5 px-6 py-2">
            <button
              type="button"
              class="flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors"
              [class]="
                !viewingSubAgent()
                  ? 'border-accent/50 bg-accent/10 text-white'
                  : 'border-white/10 bg-white/5 text-mist/60 hover:text-mist'
              "
              (click)="backToMain()"
            >
              <app-agent-status [status]="streaming() ? 'running' : null" [small]="true" />
              <span>{{ 'agents.main' | transloco }}</span>
            </button>
            @for (agent of subAgents(); track agent.id) {
              <button
                type="button"
                class="flex max-w-56 items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors"
                [class]="
                  agent.id === workspace.activeAgentId()
                    ? 'border-accent/50 bg-accent/10 text-white'
                    : 'border-white/10 bg-white/5 text-mist/60 hover:text-mist'
                "
                (click)="viewAgent(agent.id)"
              >
                <app-agent-status [status]="agent.agentStatus" [small]="true" />
                <span class="truncate">{{ agent.title }}</span>
              </button>
            }
          </div>
        }

        <div class="relative">
          @if (workspace.permission(); as request) {
            <app-permission-overlay [request]="request" />
          }
          @if (workspace.question(); as request) {
            <app-question-overlay [request]="request" />
          }
          <app-composer (composing)="composing.set($event)" />
        </div>
      } @else {
        <div
          class="flex flex-1 items-center justify-center px-6 text-center text-base text-mist/40"
        >
          {{ 'tabs.empty' | transloco }}
        </div>
      }
    </div>

    @if (revertTarget(); as target) {
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      >
        <div class="w-[32rem] rounded-2xl border border-white/10 bg-navy shadow-2xl">
          <header class="border-b border-white/10 px-6 py-4">
            <h2 class="text-base font-semibold text-white">{{ 'chat.revertTitle' | transloco }}</h2>
          </header>
          <div class="space-y-3 px-6 py-5">
            <p class="text-sm leading-relaxed text-mist/60">
              {{ 'chat.revertDetail' | transloco }}
            </p>
            <pre
              class="max-h-32 overflow-auto rounded-xl border border-white/10 bg-ink/60 px-4 py-3 text-sm whitespace-pre-wrap text-mist"
              >{{ target.content }}</pre>
            <label class="flex items-center gap-2 text-sm text-mist">
              <input
                type="checkbox"
                class="accent-accent"
                [checked]="revertFiles()"
                (change)="revertFiles.set($any($event.target).checked)"
              />
              {{ 'chat.revertFiles' | transloco }}
            </label>
          </div>
          <footer class="flex justify-end gap-2 border-t border-white/10 px-6 py-4">
            <button
              type="button"
              class="rounded-full border border-white/15 px-4 py-2 text-sm text-mist hover:bg-white/5"
              (click)="revertTarget.set(null)"
            >
              {{ 'common.cancel' | transloco }}
            </button>
            <button
              type="button"
              class="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-ink hover:bg-accent/90"
              (click)="confirmRevert(target)"
            >
              {{ 'chat.revertConfirm' | transloco }}
            </button>
          </footer>
        </div>
      </div>
    }
  `,
})
export class ChatView {
  protected readonly workspace = inject(WorkspaceService);
  protected readonly settings = inject(SettingsService);
  protected readonly tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  protected readonly revertTarget = signal<Message | null>(null);
  protected readonly revertFiles = signal(true);
  protected readonly atBottom = signal(true);
  protected readonly highlightId = signal<string | null>(null);
  protected readonly composing = signal(false);
  protected readonly projectOpen = signal(false);

  private readonly scrollRef = viewChild<ElementRef<HTMLDivElement>>('scroll');

  protected readonly session = this.workspace.activeAgent;
  protected readonly subAgents = this.workspace.activeSubAgents;
  protected readonly viewingSubAgent = computed(() => {
    const root = this.workspace.activeSession();
    const agent = this.workspace.activeAgentId();
    return !!root && !!agent && agent !== root.id;
  });
  protected readonly messages = computed(() => {
    const session = this.session();
    return session ? this.workspace.messagesFor(session.id) : [];
  });
  protected readonly liveTools = computed(() => {
    const session = this.session();
    return session ? this.workspace.liveToolsFor(session.id) : [];
  });
  protected readonly timeline = computed<ChatEntry[]>(() => {
    const messages = this.messages();
    const known = new Set(messages.map((message) => message.id));
    const anchored = new Map<string, LiveToolCall[]>();
    const loose: LiveToolCall[] = [];
    for (const tool of this.liveTools()) {
      if (tool.anchor && known.has(tool.anchor)) {
        const group = anchored.get(tool.anchor);
        if (group) {
          group.push(tool);
        } else {
          anchored.set(tool.anchor, [tool]);
        }
      } else {
        loose.push(tool);
      }
    }

    const entries: ChatEntry[] = [];
    const commands = new Map<string, string>();
    const summaries = new Map<string, string>();
    for (const message of messages) {
      for (const call of message.toolCalls) {
        const command = this.commandOf(call.name, call.arguments);
        if (command) {
          commands.set(call.id, command);
        }
        const summary = this.summaryOf(call.name, call.arguments);
        if (summary !== null) {
          summaries.set(call.id, summary);
        }
      }
    }
    for (const message of messages) {
      const entry = this.messageEntry(message, commands, summaries);
      if (entry.kind !== 'tool' || !HIDDEN_TOOLS.has(entry.name)) {
        entries.push(entry);
      }
      for (const tool of anchored.get(message.id) ?? []) {
        if (!HIDDEN_TOOLS.has(tool.name)) {
          entries.push(this.toolEntry(tool));
        }
      }
    }
    for (const tool of loose) {
      if (!HIDDEN_TOOLS.has(tool.name)) {
        entries.push(this.toolEntry(tool));
      }
    }
    return this.groupTools(entries);
  });
  protected readonly streaming = computed(() => {
    const session = this.session();
    return session ? this.workspace.isStreaming(session.id) : false;
  });
  protected readonly waiting = computed(() => {
    if (!this.streaming()) {
      return false;
    }
    const entries = this.timeline();
    const last = entries[entries.length - 1];
    return !!last && last.kind === 'message' && last.message.role === 'user';
  });
  protected readonly error = computed(() => {
    const session = this.session();
    return session ? this.workspace.errorFor(session.id) : null;
  });

  constructor() {
    effect(() => {
      this.messages();
      this.liveTools();
      this.streaming();
      if (!this.atBottom()) {
        return;
      }
      queueMicrotask(() => this.scrollToBottom());
    });

    effect(() => {
      const target = this.workspace.scrollTarget();
      if (!target) {
        return;
      }
      queueMicrotask(() => this.goToMessage(target.id));
    });

    effect(() => {
      this.workspace.activeSessionId();
      untracked(() => this.composing.set(false));
    });
  }

  protected isLast(message: Message): boolean {
    const entries = this.timeline();
    const last = entries[entries.length - 1];
    return !!last && last.kind === 'message' && last.message.id === message.id;
  }

  protected isThinking(message: Message): boolean {
    return (
      this.streaming() && message.role === 'assistant' && !message.content && this.isLast(message)
    );
  }

  protected attachmentPreview(attachment: MessageAttachment): string {
    return attachment.kind === 'image'
      ? `data:${attachment.mimeType};base64,${attachment.data}`
      : '';
  }

  protected formatSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  protected gitFor(projectId: string) {
    return this.workspace.gitInfoFor(projectId);
  }

  protected toggleProjectMenu(): void {
    const next = !this.projectOpen();
    this.projectOpen.set(next);
    if (next) {
      for (const project of this.workspace.projects()) {
        void this.workspace.loadGitInfo(project.id);
      }
    }
  }

  protected async selectProject(projectId: string): Promise<void> {
    this.projectOpen.set(false);
    const session = this.workspace.activeSession();
    if (!session) {
      return;
    }
    try {
      await this.workspace.changeSessionProject(session.id, projectId);
    } catch (error) {
      console.error(error);
    }
  }

  private messageEntry(
    message: Message,
    commands: Map<string, string>,
    summaries: Map<string, string>,
  ): ChatEntry {
    if (message.role === 'tool') {
      const command = message.toolCallId ? (commands.get(message.toolCallId) ?? '') : '';
      const summary = message.toolCallId ? summaries.get(message.toolCallId) : undefined;
      return {
        kind: 'tool',
        key: message.id,
        name: message.toolName ?? 'tool',
        summary: this.toolSummary(message.toolName ?? 'tool', command, summary ?? message.content),
        command,
        output: message.content,
        status: message.status ?? 'ok',
        changes: message.changes,
      };
    }
    return { kind: 'message', key: message.id, message };
  }

  private toolEntry(tool: LiveToolCall): ChatEntry {
    const command = this.commandOf(tool.name, tool.arguments);
    return {
      kind: 'tool',
      key: tool.callId,
      name: tool.name,
      summary: this.toolSummary(tool.name, command, tool.summary),
      command,
      output: tool.output,
      status: tool.status,
      changes: tool.changes,
    };
  }

  private groupTools(entries: ChatEntry[]): ChatEntry[] {
    const grouped: ChatEntry[] = [];
    let group: ToolEntry[] = [];
    let name = '';
    const flush = (): void => {
      if (group.length >= 2) {
        grouped.push({
          kind: 'toolGroup',
          key: `group:${name}:${group[0].key}`,
          name,
          items: group.map((tool) => ({
            key: tool.key,
            label: tool.summary,
            output: tool.output,
            status: tool.status,
            additions: tool.changes.reduce((sum, change) => sum + change.additions, 0),
            deletions: tool.changes.reduce((sum, change) => sum + change.deletions, 0),
            path: tool.changes[0]?.path ?? null,
          })),
        });
      } else {
        grouped.push(...group);
      }
      group = [];
      name = '';
    };
    for (const entry of entries) {
      if (entry.kind === 'tool' && GROUPABLE_TOOLS.has(entry.name)) {
        if (name && entry.name !== name) {
          flush();
        }
        name = entry.name;
        group.push(entry);
      } else {
        flush();
        grouped.push(entry);
      }
    }
    flush();
    return grouped;
  }

  private commandOf(name: string, args: string): string {
    if (name !== 'bash') {
      return '';
    }
    try {
      const parsed = JSON.parse(args) as { command?: unknown };
      return typeof parsed.command === 'string' ? parsed.command : '';
    } catch {
      return '';
    }
  }

  private summaryOf(name: string, args: string): string | null {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args) as Record<string, unknown>;
    } catch {
      return null;
    }
    const text = (key: string): string =>
      typeof parsed[key] === 'string' ? (parsed[key] as string) : '';
    switch (name) {
      case 'bash':
        return text('command');
      case 'read':
      case 'write':
      case 'edit':
      case 'ls':
        return this.relativePath(text('path'));
      case 'glob':
      case 'grep':
        return text('pattern');
      case 'webfetch':
        return text('url');
      case 'websearch':
        return text('query');
      case 'task':
        return text('description');
      default:
        return null;
    }
  }

  private relativePath(path: string): string {
    const root = this.workspace.activeProject()?.path;
    const normalized = path.replace(/\\/g, '/');
    if (!root) {
      return normalized;
    }
    const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized.startsWith(`${base}/`)) {
      return normalized.slice(base.length + 1);
    }
    return normalized;
  }

  private toolSummary(name: string, command: string, fallback: string): string {
    const text = name === 'bash' && command ? command : fallback;
    const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? '';
    return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
  }

  protected shortModel(model: string): string {
    const parts = model.split('/');
    return parts.length > 1 ? parts[1] : model;
  }

  protected cacheRate(message: Message): string {
    if (!message.promptTokens) {
      return '0';
    }
    return ((message.cachedTokens / message.promptTokens) * 100).toFixed(1);
  }

  protected money(value: number): string {
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  }

  protected async confirmRevert(target: Message): Promise<void> {
    await this.workspace.revertToMessage(target.id, this.revertFiles());
    this.revertTarget.set(null);
  }

  protected backToMain(): void {
    const root = this.workspace.activeSession();
    if (root) {
      this.workspace.viewAgent(root.id, null);
    }
  }

  protected viewAgent(agentId: string): void {
    const root = this.workspace.activeSession();
    if (root) {
      this.workspace.viewAgent(root.id, agentId);
    }
  }

  protected entryAnchor(entry: MessageEntry): string {
    return `msg-${entry.message.id}`;
  }

  protected onScroll(): void {
    const element = this.scrollRef()?.nativeElement;
    if (!element) {
      return;
    }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    this.atBottom.set(distance < 48);
  }

  private goToMessage(messageId: string): void {
    const element = document.getElementById(`msg-${messageId}`);
    if (!element) {
      return;
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.highlightId.set(messageId);
    setTimeout(() => {
      if (this.highlightId() === messageId) {
        this.highlightId.set(null);
      }
    }, 1200);
  }

  protected scrollToBottom(smooth = false): void {
    const element = this.scrollRef()?.nativeElement;
    if (element) {
      if (smooth) {
        element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
      } else {
        element.scrollTop = element.scrollHeight;
      }
    }
    this.atBottom.set(true);
  }
}
