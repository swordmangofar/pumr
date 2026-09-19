import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { FileChange, LiveToolCall, Message } from '../core/models';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { Composer } from './composer';
import { AgentStatus } from './agent-status';
import { PermissionOverlay } from './permission-overlay';
import { PumaLoader } from './puma-loader';
import { StreamText } from './stream-text';
import { ToolCard } from './tool-card';

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

type ChatEntry = MessageEntry | ToolEntry;

@Component({
  selector: 'app-chat-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TranslocoPipe,
    Composer,
    PermissionOverlay,
    ToolCard,
    AgentStatus,
    PumaLoader,
    StreamText,
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
              @if (messages().length === 0 && liveTools().length === 0) {
                <p class="py-24 text-center text-base text-mist/40">
                  {{ 'chat.empty' | transloco }}
                </p>
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
                          <button
                            type="button"
                            class="mt-3 text-xs text-mist/30 opacity-0 transition-opacity group-hover:opacity-100 hover:text-accent"
                            [title]="'chat.revert' | transloco"
                            (click)="revertTarget.set(entry.message)"
                          >
                            ↩
                          </button>
                          <div
                            class="max-w-[85%] rounded-2xl rounded-tr-md border border-accent/25 bg-accent/10 px-4 py-3 text-[15px] whitespace-pre-wrap text-white"
                          >
                            {{ entry.message.content }}
                          </div>
                        </div>
                      }
                      @default {
                        <div>
                          @if (entry.message.reasoning) {
                            <details class="mb-3 rounded-xl border border-white/10 bg-navy/30">
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
                              <div
                                class="max-h-80 overflow-y-auto border-t border-white/10 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap text-mist/60"
                              >
                                <app-stream-text [content]="entry.message.reasoning" />
                              </div>
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
          <div class="flex flex-wrap items-center gap-2 border-t border-white/10 px-6 py-2">
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
          <app-composer />
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
    for (const message of messages) {
      for (const call of message.toolCalls) {
        const command = this.commandOf(call.name, call.arguments);
        if (command) {
          commands.set(call.id, command);
        }
      }
    }
    for (const message of messages) {
      entries.push(this.messageEntry(message, commands));
      for (const tool of anchored.get(message.id) ?? []) {
        entries.push(this.toolEntry(tool));
      }
    }
    for (const tool of loose) {
      entries.push(this.toolEntry(tool));
    }
    return entries;
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
    if (!last || last.kind !== 'message') {
      return false;
    }
    if (last.message.role === 'user') {
      return true;
    }
    return last.message.role === 'assistant' && !last.message.content && !last.message.reasoning;
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
  }

  protected isLast(message: Message): boolean {
    const entries = this.timeline();
    const last = entries[entries.length - 1];
    return !!last && last.kind === 'message' && last.message.id === message.id;
  }

  private messageEntry(message: Message, commands: Map<string, string>): ChatEntry {
    if (message.role === 'tool') {
      const command = message.toolCallId ? (commands.get(message.toolCallId) ?? '') : '';
      return {
        kind: 'tool',
        key: message.id,
        name: message.toolName ?? 'tool',
        summary: this.toolSummary(message.toolName ?? 'tool', command, message.content),
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
