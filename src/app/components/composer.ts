import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  EndpointInfo,
  Mention,
  MentionKind,
  Message,
  MessageAttachment,
  Mode,
  SendMessageArgs,
  TextBlock,
  UserSystemPrompt,
  WorkspaceEntry,
} from '../core/models';
import { OPENROUTER_PROVIDER, api, providerIdOf } from '../core/api';
import { CapabilityCatalogService, searchCapabilities } from '../core/capability-catalog.service';
import { formatTokenCount } from '../core/format';
import { displayHotkey, HotkeyAction, hotkeyBindings, matchesAction } from '../core/hotkeys';
import { ModelsService } from '../core/models.service';
import { ProvidersService } from '../core/providers.service';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { MessageQueueService } from '../core/message-queue.service';
import { resolveMode } from '../core/modes';
import { promptCommands } from '../core/prompt-commands';
import {
  SIDE_QUESTION_COMMAND,
  SideQuestionService,
  sideQuestionOf,
} from '../core/side-question.service';
import { AttachmentPreview } from './attachment-preview';
import { ModelMenu, formatModelContext, formatModelPrice } from './model-menu';
import { ProviderMark } from './provider-mark';
import { ComposerEditorService, MentionQuery, trimEdges } from './composer-editor.service';

const REASONING_OPTIONS = ['off', 'low', 'medium', 'high'];
const MENTION_KINDS: MentionKind[] = ['file', 'directory', 'website', 'skill', 'mcp'];

const MENTION_TOKEN_RE = /@(file|directory|website|skill|mcp):([^\s]+)/g;
/** One or more such tokens in a row, with the single space on either side. */
const MENTION_GAP_RE = /[ \t]?(?:@(?:file|directory|website|skill|mcp):[^\s]+[ \t]?)+/g;

/**
 * A line the chat box does not send as typed because it starts with a slash:
 * - `ask` takes the text after its name (`/btw`),
 * - `prompt` calls one of the user's prompts: the line goes to the agent with
 *   that prompt and needs nothing after its name (`/code-review`),
 * - `picker` lists choices to pick from with the keyboard,
 * - `action` does something in the app as soon as it is picked (`/revert`).
 */
interface SlashCommand {
  name: string;
  kind: 'ask' | 'prompt' | 'picker' | 'action';
  /** Translation key of the line that explains a command of the chat box. */
  hint?: string;
  /** The prompt of "Your prompts" that the command calls. */
  prompt?: UserSystemPrompt;
}

/** The command that takes the session back to its latest prompt. */
const REVERT_COMMAND = 'revert';

/** The chat box's own commands; each of the user's prompts adds one. */
const CHAT_BOX_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: SIDE_QUESTION_COMMAND, hint: 'chat.sideQuestionHint', kind: 'ask' },
  { name: 'effort', hint: 'composer.commandEffort', kind: 'picker' },
  { name: 'mode', hint: 'composer.commandMode', kind: 'picker' },
  { name: 'model', hint: 'composer.commandModel', kind: 'picker' },
  { name: 'provider', hint: 'composer.commandProvider', kind: 'picker' },
  { name: REVERT_COMMAND, hint: 'composer.commandRevert', kind: 'action' },
];

/** An editor that holds nothing but a command name still being typed. */
const SLASH_QUERY_RE = /^\/([\p{L}\p{N}-]*)$/u;
/** An editor that holds a command name and, on the same line, what follows it. */
const SLASH_ARGUMENT_RE = /^\/([\p{L}\p{N}-]+)[ \u00a0]([^\n]*)$/u;
/** A draft that starts with a command name. */
const SLASH_DRAFT_RE = /^\/([\p{L}\p{N}-]+)(?:\s|$)/u;

/** Models `/model` lists at most; typing narrows the list down. */
const SLASH_MODEL_ROWS = 60;

/** What a row of the slash menu shows. */
interface SlashRow {
  id: string;
  label: string;
  detail: string;
  /** The choice that is in effect now. */
  current: boolean;
  /** Icon of a routing choice, as a path in a 20-unit box. */
  icon?: string;
  /** Drawn as a solid shape instead of an outline. */
  iconFilled?: boolean;
  /** Provider whose mark leads a model. */
  source?: string;
  /** The endpoint a provider row stands for, shown with its price and health. */
  endpoint?: EndpointInfo;
}

/** Something a picker command offers. */
interface SlashChoice extends SlashRow {
  /** What a typed term is matched against. */
  search: string;
  apply: () => Promise<void>;
}

/** A row of the slash menu: a command, or a choice of a picker command. */
interface SlashItem extends SlashRow {
  /** Commands are shown in the monospace face they are typed in. */
  command: boolean;
  select: () => void;
}

/** The mark of routing left to OpenRouter, as in the provider menu. */
const AUTO_PROVIDER_ICON = 'm10 2 1.6 4.4L16 8l-4.4 1.6L10 14l-1.6-4.4L4 8l4.4-1.6z';

/** Semantic indicator colours for endpoint/usage meters. */
const METER_GOOD = '#34d399';
const METER_WARN = '#fbbf24';
const METER_BAD = '#fb7185';
const METER_MUTED = 'rgba(255,255,255,0.25)';
/** Context-meter fill ratios at which it turns amber and red. */
const METER_WARN_RATIO = 0.75;
const METER_BAD_RATIO = 0.9;

interface MentionItem {
  kind: MentionKind;
  value: string;
  label: string;
  sublabel: string | null;
  /** Render the sublabel as prose (skill descriptions) instead of a path. */
  prose?: boolean;
}

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const CONTEXT_CIRCUMFERENCE = 2 * Math.PI * 6;

const TEXT_EXTENSIONS = new Set([
  'c',
  'cc',
  'conf',
  'cpp',
  'cs',
  'css',
  'csv',
  'env',
  'go',
  'h',
  'hpp',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'log',
  'lua',
  'md',
  'mjs',
  'php',
  'properties',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'svelte',
  'swift',
  'toml',
  'ts',
  'tsx',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
]);

const PROVIDER_PRESETS = [
  {
    value: 'auto:throughput',
    key: 'provider.presetThroughput',
    hint: 'provider.presetThroughputHint',
  },
  {
    value: 'auto:price',
    key: 'provider.presetPrice',
    hint: 'provider.presetPriceHint',
  },
  {
    value: 'auto:value',
    key: 'provider.presetValue',
    hint: 'provider.presetValueHint',
  },
] as const;

/**
 * Re-encodes an image element as a PNG file. Pasted images arrive as blob:
 * URLs that the CSP's connect-src keeps fetch() from reading, but a
 * same-origin image can always be drawn. Resolves to null for an image that
 * fails to load or would taint the canvas.
 */
async function imageToFile(image: HTMLImageElement): Promise<File | null> {
  try {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new File([blob], 'image.png', { type: 'image/png' }) : null;
  } catch {
    return null;
  }
}

@Component({
  selector: 'app-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ComposerEditorService],
  encapsulation: ViewEncapsulation.None,
  imports: [NgTemplateOutlet, TranslocoPipe, AttachmentPreview, ProviderMark, ModelMenu],
  styles: [
    `
      .composer-editor:empty::before {
        content: attr(data-placeholder);
        color: color-mix(in oklab, var(--color-mist) 50%, transparent);
        pointer-events: none;
      }
      .composer-editor .mention-pill {
        display: inline-flex;
        align-items: center;
        gap: 0.2rem;
        margin: 0 0.15rem;
        padding: 0.05rem 0.3rem 0.05rem 0.45rem;
        border-radius: 9999px;
        border: 1px solid color-mix(in oklab, var(--color-accent) 45%, transparent);
        background: color-mix(in oklab, var(--color-accent) 14%, transparent);
        font-size: 0.8rem;
        line-height: 1.5;
        white-space: nowrap;
        vertical-align: baseline;
        user-select: none;
      }
      .composer-editor .mention-pill-icon {
        width: 0.8rem;
        height: 0.8rem;
        flex-shrink: 0;
        color: var(--color-accent);
      }
      .composer-editor .mention-pill-kind {
        color: var(--color-accent);
        font-weight: 600;
      }
      .composer-editor .mention-pill-label {
        max-width: 12rem;
        overflow: hidden;
        text-overflow: ellipsis;
        color: color-mix(in oklab, var(--color-mist) 82%, transparent);
      }
      .composer-editor .mention-pill-remove {
        display: grid;
        place-items: center;
        width: 1rem;
        height: 1rem;
        border-radius: 9999px;
        color: color-mix(in oklab, var(--color-mist) 55%, transparent);
        cursor: pointer;
      }
      .composer-editor .mention-pill-remove:hover {
        background: color-mix(in oklab, white 12%, transparent);
        color: white;
      }
      .composer-editor .text-block-pill {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        margin: 0 0.15rem;
        padding: 0.15rem 0.4rem 0.15rem 0.5rem;
        border-radius: 0.6rem;
        border: 1px solid color-mix(in oklab, white 12%, transparent);
        background: color-mix(in oklab, white 6%, transparent);
        font-size: 0.8rem;
        line-height: 1.4;
        white-space: nowrap;
        vertical-align: middle;
        user-select: none;
        cursor: pointer;
      }
      .composer-editor .text-block-pill:hover {
        border-color: color-mix(in oklab, var(--color-accent) 45%, transparent);
        background: color-mix(in oklab, var(--color-accent) 10%, transparent);
      }
      .composer-editor .text-block-pill-icon {
        width: 0.85rem;
        height: 0.85rem;
        flex-shrink: 0;
        color: var(--color-accent);
      }
      .composer-editor .text-block-pill-label {
        max-width: 14rem;
        overflow: hidden;
        text-overflow: ellipsis;
        color: color-mix(in oklab, var(--color-mist) 82%, transparent);
      }
      .composer-editor .text-block-pill-remove {
        display: grid;
        place-items: center;
        width: 1rem;
        height: 1rem;
        border-radius: 9999px;
        color: color-mix(in oklab, var(--color-mist) 55%, transparent);
        cursor: pointer;
      }
      .composer-editor .text-block-pill-remove:hover {
        background: color-mix(in oklab, white 12%, transparent);
        color: white;
      }
    `,
  ],
  template: `
    <!-- What the provider menu and /provider show of an endpoint. -->
    <ng-template #endpointInfo let-endpoint>
      <div class="flex items-center justify-between gap-3">
        <span class="flex min-w-0 items-center gap-2">
          @if (providerIcon(endpoint.providerSlug); as icon) {
            <img
              [src]="icon"
              alt=""
              class="h-5 w-5 shrink-0 rounded object-contain"
              (error)="providerIconError(endpoint.providerSlug)"
            />
          } @else {
            <span
              class="grid h-5 w-5 shrink-0 place-items-center rounded bg-white/10 text-[10px] font-semibold text-mist/60"
            >
              {{ initial(endpoint.providerName) }}
            </span>
          }
          <span class="truncate text-sm text-white">{{
            endpoint.providerName
          }}</span>
          @if (endpoint.training) {
            <span
              class="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
              [attr.title]="'provider.trainsHint' | transloco"
            >
              {{ 'provider.trains' | transloco }}
            </span>
          }
          @if (endpoint.quantization) {
            <span
              class="shrink-0 rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] text-mist/40"
            >
              {{ endpoint.quantization }}
            </span>
          }
        </span>
        <span
          class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums"
          [style.color]="priceColor(endpoint)"
          [style.background-color]="priceBackground(endpoint)"
          [attr.title]="'provider.priceHint' | transloco"
        >
          {{ price(endpoint.promptPricePerM) }} /
          {{ price(endpoint.completionPricePerM) }}
        </span>
      </div>
      <div class="mt-1.5 flex items-center gap-3 text-xs text-mist/40">
        @let up = uptime(endpoint);
        @if (up !== null) {
          <span
            class="flex items-center gap-1.5 font-medium"
            [style.color]="uptimeColor(endpoint)"
            [attr.title]="'provider.uptime' | transloco"
          >
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full"
              [style.background-color]="uptimeColor(endpoint)"
            ></span>
            {{ up.toFixed(1) }}%
          </span>
        }
        @if (endpoint.throughputLast30m !== null) {
          <span [attr.title]="'provider.tokensPerSecond' | transloco">
            {{ endpoint.throughputLast30m.toFixed(0) }} tok/s
          </span>
        }
        @if (endpoint.latencyLast30m !== null) {
          <span [attr.title]="'provider.latency' | transloco">
            {{ endpoint.latencyLast30m.toFixed(0) }} ms
          </span>
        }
        <span
          [attr.title]="
            ('provider.context' | transloco) +
            ': ' +
            endpoint.contextLength.toLocaleString()
          "
        >
          {{ context(endpoint.contextLength) }}
        </span>
        @if (region(endpoint.slug); as reg) {
          <span class="text-mist/40">{{ reg }}</span>
        }
      </div>
    </ng-template>

    <div class="px-4 pt-2 pb-3">
      <div
        #card
        class="glass-inset relative mx-auto w-full max-w-4xl rounded-2xl shadow-lg shadow-black/20 transition-colors focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/15"
        [class]="dragging() ? 'border-accent/60 ring-2 ring-accent/25' : ''"
        (dragover)="onDragOver($event)"
        (dragleave)="onDragLeave($event)"
        (drop)="onDrop($event)"
      >
        @if (attachments().length > 0) {
          <div class="flex flex-wrap gap-2 px-4 pt-3">
            @for (attachment of attachments(); track attachment.id) {
              <div
                class="relative flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/5 py-1.5 pr-7 pl-1.5 transition hover:border-accent/50 hover:bg-white/10"
                (click)="previewAttachment.set(attachment)"
              >
                @if (attachment.kind === 'image') {
                  <img
                    [src]="preview(attachment)"
                    [alt]="attachment.name"
                    class="h-10 w-10 shrink-0 rounded-lg object-cover"
                  />
                } @else if (attachment.kind === 'pdf') {
                  <span
                    class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-rose-500/15 text-[10px] font-semibold tracking-wide text-rose-300"
                  >
                    {{ 'common.pdf' | transloco }}
                  </span>
                } @else {
                  <span
                    class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/10 text-mist/50"
                  >
                    <svg class="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path
                        d="M11.5 2.5H5.5A1.5 1.5 0 0 0 4 4v12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 16V7zM11.5 2.5V7H16M7 11h6M7 13.5h4"
                        stroke="currentColor"
                        stroke-width="1.4"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </span>
                }
                <span class="flex min-w-0 flex-col">
                  <span class="max-w-44 truncate text-xs font-medium text-white">{{
                    attachment.name
                  }}</span>
                  <span class="text-[11px] text-mist/40">
                    {{ formatSize(attachment.size) }}
                    @if (attachment.kind === 'text' && attachment.lines !== null) {
                      · {{ 'composer.attachmentLines' | transloco: { count: attachment.lines } }}
                    }
                  </span>
                </span>
                <button
                  type="button"
                  class="absolute top-1 right-1 grid h-5 w-5 place-items-center rounded-full text-mist/40 transition-colors hover:bg-white/10 hover:text-white"
                  [attr.aria-label]="'composer.removeAttachment' | transloco"
                  [attr.title]="'composer.removeAttachment' | transloco"
                  (click)="removeAttachment(attachment.id); $event.stopPropagation()"
                >
                  <svg class="h-3 w-3" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M6 6l8 8M14 6l-8 8"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </div>
            }
          </div>
        }

        @if (attachmentError(); as error) {
          <p class="px-4 pt-2 text-xs text-rose-300">{{ error | transloco }}</p>
        }

        @if (queued().length > 0) {
          <div class="flex flex-col gap-1.5 border-b border-white/5 px-4 py-2.5">
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-medium tracking-wide text-mist/40 uppercase">
                {{ 'chat.queued' | transloco: { count: queued().length } }}
              </span>
              <button
                type="button"
                class="text-[11px] text-mist/40 transition-colors hover:text-white"
                (click)="clearQueue()"
              >
                {{ 'common.clear' | transloco }}
              </button>
            </div>
            @for (item of queued(); track $index) {
              <div
                class="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 py-1.5 pr-1.5 pl-3"
              >
                <span class="min-w-0 flex-1 truncate text-xs text-mist/70">{{ item.content }}</span>
                @if (item.attachments?.length) {
                  <span class="flex shrink-0 items-center gap-1 text-[11px] text-mist/40">
                    <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                    {{ item.attachments?.length }}
                  </span>
                }
                <button
                  type="button"
                  class="grid h-5 w-5 shrink-0 place-items-center rounded-full text-mist/40 transition-colors hover:bg-white/10 hover:text-white"
                  [attr.aria-label]="'common.remove' | transloco"
                  (click)="removeQueued($index)"
                >
                  <svg class="h-3 w-3" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M6 6l8 8M14 6l-8 8"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </div>
            }
          </div>
        }

        @if (mentionOpen()) {
          <div class="fixed inset-0 z-30" (click)="closeMention()"></div>
          <div
            class="absolute right-3 bottom-full left-3 z-40 mb-2 max-h-[min(22rem,50vh)] overflow-y-auto glass-pop rounded-2xl shadow-2xl"
            id="composer-mention-menu"
          >
            @for (item of mentionItems(); track item.kind + ':' + item.value; let index = $index) {
              <button
                type="button"
                class="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors"
                [class]="
                  index === mentionIndex()
                    ? 'bg-accent/10 text-white'
                    : 'text-mist hover:bg-white/5'
                "
                (mousedown)="$event.preventDefault()"
                (click)="selectMention(item)"
              >
                <svg
                  class="h-4 w-4 shrink-0 text-accent"
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    [attr.d]="mentionIcon(item.kind)"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span class="min-w-0 flex-1">
                  <span class="block truncate">{{ item.label }}</span>
                  @if (item.sublabel) {
                    <span
                      class="block truncate text-xs text-mist/40"
                      [class.font-mono]="!item.prose"
                      [attr.title]="item.prose ? item.sublabel : null"
                      >{{ item.sublabel }}</span
                    >
                  }
                </span>
                <span class="shrink-0 text-[10px] tracking-wide text-mist/40 uppercase">{{
                  item.kind
                }}</span>
              </button>
            } @empty {
              <p class="px-4 py-4 text-center text-sm text-mist/40">
                {{ mentionEmptyKey() | transloco }}
              </p>
            }
          </div>
        }

        @if (slashOpen()) {
          <div
            #slashMenu
            class="absolute right-3 bottom-full left-3 z-40 mb-2 max-h-[min(22rem,50vh)] overflow-y-auto glass-pop rounded-2xl shadow-2xl"
            id="composer-command-menu"
            role="listbox"
          >
            @for (item of slashItems(); track item.id; let index = $index) {
              <button
                type="button"
                role="option"
                class="flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm transition-colors"
                [class]="
                  index === slashActive() ? 'bg-accent/10 text-white' : 'text-mist hover:bg-white/5'
                "
                [attr.aria-selected]="index === slashActive()"
                (mousedown)="$event.preventDefault()"
                (click)="item.select()"
              >
                @if (item.endpoint; as endpoint) {
                  <span class="block min-w-0 flex-1">
                    <ng-container
                      [ngTemplateOutlet]="endpointInfo"
                      [ngTemplateOutletContext]="{ $implicit: endpoint }"
                    />
                  </span>
                } @else {
                  @if (item.icon; as icon) {
                    <svg
                      class="h-4 w-4 shrink-0 self-center text-accent"
                      viewBox="0 0 20 20"
                      [attr.fill]="item.iconFilled ? 'currentColor' : 'none'"
                      aria-hidden="true"
                    >
                      <path
                        [attr.d]="icon"
                        [attr.stroke]="item.iconFilled ? null : 'currentColor'"
                        stroke-width="1.6"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  }
                  @if (item.source; as source) {
                    <app-provider-mark class="shrink-0 self-center" [provider]="source" size="xs" />
                  }
                  <span class="shrink-0" [class]="item.command ? 'font-mono text-accent' : ''">{{
                    item.label
                  }}</span>
                  <span class="min-w-0 flex-1 text-xs leading-snug text-mist/50">{{
                    item.detail
                  }}</span>
                }
                @if (item.current) {
                  <svg
                    class="h-4 w-4 shrink-0 self-center text-accent"
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M5 10.5 9 14.5 15.5 6"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                }
              </button>
            } @empty {
              @if (!slashLoading()) {
                <p class="px-4 py-3 text-sm text-mist/40">{{ slashNotice() | transloco }}</p>
              }
            }
            @if (slashLoading()) {
              <p class="px-4 py-3 text-sm text-mist/40">{{ 'common.loading' | transloco }}</p>
            }
          </div>
        }

        <!-- The editor grows and shrinks with its content through CSS alone.
             Sizing it from script forces a full layout on every keystroke. -->
        <div
          #editor
          class="composer-editor block max-h-[min(45vh,22rem)] min-h-[5.5rem] w-full overflow-y-auto bg-transparent px-4 pt-3.5 pr-3 pb-1 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-white outline-none"
          contenteditable="true"
          role="textbox"
          aria-multiline="true"
          enterkeyhint="send"
          [attr.aria-label]="'chat.placeholder' | transloco"
          [attr.data-placeholder]="
            ('chat.placeholder' | transloco) + ' · ' + ('chat.hintCommands' | transloco)
          "
          (input)="onEditorInput()"
          (keydown)="onKeydown($event)"
          (keyup.arrowleft)="onCaretMove()"
          (keyup.arrowright)="onCaretMove()"
          (click)="onCaretMove()"
          (paste)="onPaste($event)"
        ></div>

        <!-- One row where it fits: labels go and the model name shortens
             before a picker wraps, and only a very narrow chat puts the buttons
             on a line of their own. -->
        <div
          class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 border-t border-white/5 px-4 py-2"
        >
          <div class="flex min-w-[min(100%,20rem)] flex-1 flex-wrap items-center gap-1">
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-mist/50 transition-colors hover:bg-white/5 hover:text-white"
              [attr.aria-label]="'composer.attach' | transloco"
              [attr.title]="'composer.attach' | transloco"
              (click)="openFilePicker()"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <input
              #fileInput
              type="file"
              multiple
              class="hidden"
              (change)="onFilesSelected($event)"
            />
            <!-- Model picker: the provider is always named next to the model,
                 by its mark and, unless the row is tight, in words. The small
                 basis lets a long model name shorten before the pickers wrap. -->
            <div class="max-w-max min-w-0 flex-[1_1_6rem]">
              <button
                type="button"
                class="flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full px-2 text-xs text-mist/60 transition-colors hover:bg-white/5 hover:text-white"
                [attr.aria-expanded]="modelOpen()"
                [attr.aria-controls]="modelOpen() ? 'composer-model-menu' : null"
                [attr.title]="
                  selectedModel()
                    ? ('composer.viaProvider' | transloco: { provider: selectedProviderName() })
                    : null
                "
                (click)="modelOpen.set(!modelOpen())"
                (keydown.escape)="closeMenus()"
              >
                @if (selectedModel()) {
                  <app-provider-mark [provider]="selectedProviderId()" size="xs" />
                }
                <span class="max-w-56 min-w-0 truncate">{{
                  selectedModel()?.name ??
                    ((modelsService.models().length > 0
                      ? 'modelChoice.placeholder'
                      : 'composer.noModels'
                    ) | transloco)
                }}</span>
                @if (selectedModel()) {
                  <span
                    [class]="
                      toolbarSpace() === 'tight'
                        ? 'sr-only'
                        : 'max-w-28 shrink-0 truncate text-mist/35'
                    "
                    >{{ selectedProviderName() }}</span
                  >
                }
                <svg
                  class="h-3 w-3 shrink-0 text-mist/40"
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

              @if (modelOpen()) {
                <div class="fixed inset-0 z-30" (click)="modelOpen.set(false)"></div>
                <app-model-menu
                  class="absolute bottom-full left-0 z-40 mb-2 max-h-[min(28rem,60vh)] w-[min(34rem,100%)]"
                  id="composer-model-menu"
                  [selected]="selectedModel()?.id ?? null"
                  (picked)="$event && selectModel($event)"
                  (keydown.escape)="closeMenus()"
                />
              }
            </div>

            <!-- Mode picker -->
            <div class="shrink-0">
              <button
                type="button"
                class="flex h-7 items-center gap-1.5 rounded-full px-2 text-xs text-mist/60 transition-colors hover:bg-white/5 hover:text-white"
                [attr.aria-expanded]="modeOpen()"
                [attr.aria-controls]="modeOpen() ? 'composer-mode-menu' : null"
                [attr.title]="
                  ('settings.hotkeys.chatToggleMode' | transloco) +
                  ' (' +
                  hintKeys().toggleMode +
                  ')'
                "
                (click)="modeOpen.set(!modeOpen())"
                (keydown.escape)="closeMenus()"
              >
                <span
                  class="truncate"
                  [class]="toolbarSpace() === 'roomy' ? 'max-w-40' : 'max-w-28'"
                  >{{ selectedMode()?.name }}</span
                >
                @if (selectedMode()?.planOnly) {
                  <svg
                    class="h-3 w-3 shrink-0 text-accent"
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M10 3.5 4 6v4c0 3.3 2.6 5.6 6 6.5 3.4-.9 6-3.2 6-6.5V6z"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                }
                <svg
                  class="h-3 w-3 shrink-0 text-mist/40"
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

              @if (modeOpen()) {
                <div class="fixed inset-0 z-30" (click)="modeOpen.set(false)"></div>
                <div
                  class="absolute bottom-full left-0 z-40 mb-2 w-[min(22rem,100%)] overflow-hidden glass-pop rounded-2xl shadow-2xl"
                  id="composer-mode-menu"
                  (keydown.escape)="closeMenus()"
                >
                  @for (mode of modes(); track mode.id) {
                    <button
                      type="button"
                      class="flex w-full items-start gap-2.5 border-b border-white/5 px-4 py-2.5 text-left transition-colors last:border-0"
                      [class]="mode.id === selectedMode()?.id ? 'bg-accent/10' : 'hover:bg-white/5'"
                      (click)="selectMode(mode.id)"
                    >
                      <span class="min-w-0 flex-1">
                        <span class="flex items-center gap-2">
                          <span class="truncate text-sm text-white">{{ mode.name }}</span>
                          @if (mode.planOnly) {
                            <span
                              class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent"
                            >
                              {{ 'right.planOnly' | transloco }}
                            </span>
                          }
                        </span>
                        <span class="mt-0.5 block text-xs text-mist/40">
                          {{ modeSummary(mode) }}
                        </span>
                      </span>
                    </button>
                  }
                </div>
              }
            </div>

            <!-- Reasoning: one chip showing the level in effect, so the row
                 stays on one line; the levels are in its menu -->
            <div class="shrink-0" role="group" [attr.aria-label]="'composer.reasoning' | transloco">
              <button
                type="button"
                class="flex h-7 items-center gap-1.5 rounded-full px-2 text-xs text-mist/60 transition-colors hover:bg-white/5 hover:text-white"
                aria-haspopup="menu"
                [attr.aria-expanded]="reasoningOpen()"
                [attr.aria-controls]="reasoningOpen() ? 'composer-reasoning-menu' : null"
                [attr.title]="'composer.reasoning' | transloco"
                (click)="reasoningOpen.set(!reasoningOpen())"
                (keydown.escape)="closeMenus()"
              >
                <svg
                  class="h-3 w-3 shrink-0 text-mist/40"
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M10 11.5 13.5 8M3 16a8 8 0 1 1 14 0"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span>{{ 'reasoning.' + reasoning() | transloco }}</span>
                <svg
                  class="h-3 w-3 shrink-0 text-mist/40"
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

              @if (reasoningOpen()) {
                <div class="fixed inset-0 z-30" (click)="reasoningOpen.set(false)"></div>
                <div
                  class="absolute bottom-full left-0 z-40 mb-2 w-[min(14rem,100%)] overflow-hidden glass-pop rounded-2xl shadow-2xl"
                  id="composer-reasoning-menu"
                  role="menu"
                  [attr.aria-label]="'composer.reasoning' | transloco"
                  (keydown.escape)="closeMenus()"
                >
                  @for (option of reasoningOptions; track option) {
                    <button
                      type="button"
                      role="menuitemradio"
                      class="flex w-full items-center gap-2.5 border-b border-white/5 px-4 py-2 text-left text-sm transition-colors last:border-0 disabled:opacity-30"
                      [class]="
                        option === reasoning()
                          ? 'bg-accent/10 text-white'
                          : 'text-mist hover:bg-white/5'
                      "
                      [attr.aria-checked]="option === reasoning()"
                      [disabled]="!supportsReasoning() && option !== 'off'"
                      (click)="pickReasoning(option)"
                    >
                      <span class="flex-1">{{ 'reasoning.' + option | transloco }}</span>
                      @if (option === reasoning()) {
                        <svg
                          class="h-4 w-4 shrink-0 text-accent"
                          viewBox="0 0 20 20"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M5 10.5 9 14.5 15.5 6"
                            stroke="currentColor"
                            stroke-width="1.8"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      }
                    </button>
                  }
                </div>
              }
            </div>

            <!-- Routing picker: only OpenRouter models are served by several providers -->
            @if (isOpenRouterModel()) {
              <div class="shrink-0">
                <button
                  type="button"
                  class="flex h-7 items-center gap-1.5 rounded-full px-2 text-xs text-mist/60 transition-colors hover:bg-white/5 hover:text-white"
                  [attr.aria-expanded]="providerOpen()"
                  [attr.aria-controls]="providerOpen() ? 'composer-provider-menu' : null"
                  [attr.title]="provider() === 'auto' ? ('provider.auto' | transloco) : null"
                  (click)="toggleProvider()"
                  (keydown.escape)="closeMenus()"
                >
                  <span class="flex min-w-0 items-center gap-1.5">
                    @if (presetKey(provider()); as key) {
                      <svg
                        class="h-3 w-3 shrink-0 text-accent"
                        viewBox="0 0 20 20"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          [attr.d]="presetIcon(provider())"
                          stroke="currentColor"
                          stroke-width="1.6"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        />
                      </svg>
                      <span
                        class="truncate"
                        [class]="toolbarSpace() === 'roomy' ? 'max-w-40' : 'max-w-20'"
                        >{{ key | transloco }}</span
                      >
                    } @else {
                      @if (provider() !== 'auto') {
                        @if (providerIcon(provider()); as icon) {
                          <img
                            [src]="icon"
                            alt=""
                            class="h-3 w-3 shrink-0 rounded object-contain"
                            (error)="providerIconError(provider())"
                          />
                        }
                      } @else if (toolbarSpace() !== 'roomy') {
                        <!-- The mark of the automatic choice in the menu stands in for its label -->
                        <svg
                          class="h-3 w-3 shrink-0 text-accent"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path d="m10 2 1.6 4.4L16 8l-4.4 1.6L10 14l-1.6-4.4L4 8l4.4-1.6z" />
                        </svg>
                      }
                      <span [class]="routingLabelClass()">
                        @if (provider() === 'auto') {
                          {{ 'provider.auto' | transloco }}
                        } @else {
                          {{ providerLabel() }}
                        }
                      </span>
                    }
                  </span>
                  <svg
                    class="h-3 w-3 shrink-0 text-mist/40"
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

                @if (providerOpen()) {
                  <div class="fixed inset-0 z-30" (click)="providerOpen.set(false)"></div>
                  <div
                    class="absolute bottom-full left-0 z-40 mb-2 max-h-[min(24rem,50vh)] w-[min(32rem,100%)] overflow-y-auto glass-pop rounded-2xl shadow-2xl"
                    id="composer-provider-menu"
                    (keydown.escape)="closeMenus()"
                  >
                    <div class="border-b border-white/10">
                      <button
                        type="button"
                        class="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-white/5"
                        [class]="provider() === 'auto' ? 'bg-accent/10 text-white' : 'text-mist'"
                        (click)="selectAutoProvider()"
                      >
                        <svg
                          class="h-4 w-4 shrink-0 text-accent"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path d="m10 2 1.6 4.4L16 8l-4.4 1.6L10 14l-1.6-4.4L4 8l4.4-1.6z" />
                        </svg>
                        <span class="flex-1">{{ 'provider.auto' | transloco }}</span>
                        @if (provider() === 'auto') {
                          <svg
                            class="h-4 w-4 shrink-0 text-accent"
                            viewBox="0 0 20 20"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              d="M5 10.5 9 14.5 15.5 6"
                              stroke="currentColor"
                              stroke-width="1.8"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            />
                          </svg>
                        }
                      </button>
                      @for (preset of providerPresets; track preset.value) {
                        <button
                          type="button"
                          class="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-white/5"
                          [class]="
                            provider() === preset.value ? 'bg-accent/10 text-white' : 'text-mist'
                          "
                          [attr.title]="preset.hint | transloco"
                          (click)="selectPreset(preset.value)"
                        >
                          <svg
                            class="h-4 w-4 shrink-0 text-accent"
                            viewBox="0 0 20 20"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              [attr.d]="presetIcon(preset.value)"
                              stroke="currentColor"
                              stroke-width="1.6"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            />
                          </svg>
                          <span class="flex-1">{{ preset.key | transloco }}</span>
                          @if (provider() === preset.value) {
                            <svg
                              class="h-4 w-4 shrink-0 text-accent"
                              viewBox="0 0 20 20"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M5 10.5 9 14.5 15.5 6"
                                stroke="currentColor"
                                stroke-width="1.8"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                              />
                            </svg>
                          }
                        </button>
                      }
                    </div>
                    @if (modelsService.endpointsLoading()[model()]) {
                      <p class="px-4 py-4 text-center text-sm text-mist/40">
                        {{ 'common.loading' | transloco }}
                      </p>
                    }
                    @for (endpoint of endpoints(); track endpoint.slug + endpoint.name) {
                      <button
                        type="button"
                        class="block w-full border-b border-white/5 px-4 py-2.5 text-left transition-colors hover:bg-white/5"
                        (click)="selectProvider(endpoint)"
                      >
                        <ng-container
                          [ngTemplateOutlet]="endpointInfo"
                          [ngTemplateOutletContext]="{ $implicit: endpoint }"
                        />
                      </button>
                    } @empty {
                      @if (!modelsService.endpointsLoading()[model()]) {
                        <p class="px-4 py-4 text-center text-sm text-mist/40">
                          @if (modelsService.endpointsError()[model()]; as err) {
                            {{ err }}
                          } @else {
                            {{ 'composer.noModels' | transloco }}
                          }
                        </p>
                      }
                    }
                  </div>
                }
              </div>
            }
          </div>

          <div class="flex shrink-0 items-center gap-1.5">
            @if (streaming()) {
              <button
                type="button"
                class="flex h-8 items-center justify-center gap-1.5 rounded-full bg-accent/15 text-sm font-medium text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
                [class]="actionButtonClass()"
                [attr.title]="toolbarSpace() === 'tight' ? ('chat.queue' | transloco) : null"
                [disabled]="!canQueue()"
                (click)="enqueue()"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M4 6h12M4 10h12M4 14h7"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                  />
                </svg>
                <span [class.sr-only]="toolbarSpace() === 'tight'">{{
                  'chat.queue' | transloco
                }}</span>
              </button>
              <button
                type="button"
                class="flex h-8 items-center justify-center gap-1.5 rounded-full bg-rose-500/15 text-sm font-medium text-rose-300 transition-colors hover:bg-rose-500/25"
                [class]="actionButtonClass()"
                [attr.title]="toolbarSpace() === 'tight' ? ('chat.stop' | transloco) : null"
                (click)="stop()"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="6" width="8" height="8" rx="1.5" />
                </svg>
                <span [class.sr-only]="toolbarSpace() === 'tight'">{{
                  'chat.stop' | transloco
                }}</span>
              </button>
            } @else {
              <button
                type="button"
                class="flex h-8 items-center justify-center gap-1.5 rounded-full bg-accent text-sm font-semibold text-ink transition-colors hover:bg-accent/90 disabled:opacity-40"
                [class]="actionButtonClass()"
                [attr.title]="toolbarSpace() === 'tight' ? ('chat.send' | transloco) : null"
                [disabled]="!canSend()"
                (click)="send()"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path d="M4 16V4l12 6z" />
                </svg>
                <span [class.sr-only]="toolbarSpace() === 'tight'">{{
                  'chat.send' | transloco
                }}</span>
              </button>
            }
          </div>
        </div>
      </div>

      <div
        class="mx-auto mt-1.5 flex w-full max-w-4xl items-center gap-3 px-1 text-xs text-mist/40"
      >
        <p class="hidden min-w-0 flex-1 truncate sm:block">
          @if (streaming()) {
            {{ 'chat.hintStreaming' | transloco: hintKeys() }}
          } @else {
            {{ 'chat.hint' | transloco: hintKeys() }}
            @if (!composingDraft() && hasPreviousPrompt()) {
              · {{ 'chat.hintRecall' | transloco: hintKeys() }}
            }
          }
        </p>

        <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
          @if (workspace.activeSession()) {
            <div class="group relative">
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1 text-xs font-medium text-mist/60 ring-1 ring-white/10 ring-inset transition-colors hover:bg-white/10 hover:text-white"
                [attr.aria-label]="'debug.buttonHint' | transloco"
                (click)="workspace.openDebug()"
              >
                <svg
                  class="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="m8 2 1.5 1.5M16 2l-1.5 1.5M9 7a3 3 0 0 1 6 0v3a3 3 0 0 1-6 0Z" />
                  <path
                    d="M12 13v8M8 21h8M3 8l3 1M3 13l3-1M21 8l-3 1M21 13l-3-1M6 17l-3 2M18 17l3 2"
                  />
                </svg>
                {{ 'debug.button' | transloco }}
              </button>
              <div
                class="pointer-events-none absolute right-0 bottom-full z-20 mb-2 w-60 rounded-xl border border-white/10 bg-navy px-3 py-2 text-left text-xs leading-relaxed text-mist opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100"
                role="tooltip"
              >
                {{ 'debug.buttonHint' | transloco }}
              </div>
            </div>
          }

          @if (workspace.activeSession()) {
            <div class="group relative">
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                [class]="
                  suggestHandover()
                    ? 'bg-amber-400/20 text-amber-200 ring-amber-400/50 hover:bg-amber-400/30 hover:text-white'
                    : 'bg-accent/15 text-accent ring-accent/30 hover:bg-accent/25 hover:text-white disabled:hover:bg-accent/15 disabled:hover:text-accent'
                "
                [disabled]="!canHandover()"
                [attr.aria-label]="
                  (suggestHandover() ? 'chat.handoverSuggested' : 'chat.handoverHint') | transloco
                "
                (click)="handoverSession()"
              >
                @if (handover()) {
                  <svg
                    class="h-3.5 w-3.5 animate-spin"
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      cx="10"
                      cy="10"
                      r="7"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-dasharray="24 20"
                    />
                  </svg>
                  {{ 'chat.handovering' | transloco }}
                } @else {
                  <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M3 7h11M11 4l3 3-3 3M17 13H6M9 10l-3 3 3 3"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  {{ 'chat.handover' | transloco }}
                }
              </button>
              <div
                class="pointer-events-none absolute right-0 bottom-full z-20 mb-2 w-60 rounded-xl border border-white/10 bg-navy px-3 py-2 text-left text-xs leading-relaxed text-mist opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100"
                role="tooltip"
              >
                {{
                  (suggestHandover() ? 'chat.handoverSuggested' : 'chat.handoverHint') | transloco
                }}
              </div>
            </div>
          }

          @if (workspace.activeSession()) {
            <div class="group relative">
              <button
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-full text-mist/60 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-mist/60"
                [disabled]="!canCompact()"
                [attr.aria-label]="'chat.compact' | transloco"
                (click)="compactSession()"
              >
                @if (compacting()) {
                  <svg
                    class="h-3.5 w-3.5 animate-spin"
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      cx="10"
                      cy="10"
                      r="7"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-dasharray="24 20"
                    />
                  </svg>
                } @else {
                  <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                      d="M5 3.5 10 8l5-4.5M5 16.5 10 12l5 4.5"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                }
              </button>
              <div
                class="pointer-events-none absolute right-0 bottom-full z-20 mb-2 w-60 rounded-xl border border-white/10 bg-navy px-3 py-2 text-left text-xs leading-relaxed text-mist opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100"
                role="tooltip"
              >
                {{ 'chat.compactHint' | transloco }}
              </div>
            </div>
          }

          @if (contextUsage(); as usage) {
            <span
              class="flex items-center gap-1.5"
              [title]="
                ('right.contextLength' | transloco) +
                ': ' +
                usage.usedLabel +
                ' / ' +
                usage.limitLabel +
                (usage.breakdown
                  ? ' · ' + ('chat.contextUsage' | transloco: usage.breakdown)
                  : '') +
                (usage.cached !== null
                  ? ' · ' + ('chat.contextCached' | transloco: { percent: usage.cached })
                  : '')
              "
            >
              <svg class="h-3.5 w-3.5 -rotate-90" viewBox="0 0 16 16" aria-hidden="true">
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  class="text-white/10"
                />
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  fill="none"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  class="transition-[stroke-dashoffset] duration-500 ease-out"
                  [style.stroke]="usage.color"
                  [attr.stroke-dasharray]="circumference"
                  [attr.stroke-dashoffset]="circumference * (1 - usage.ratio)"
                />
              </svg>
              <span class="tabular-nums" [style.color]="usage.color">{{ usage.percent }}%</span>
            </span>
          }

          @if (sessionCost() > 0) {
            <span class="tabular-nums text-mist/60" [title]="'chat.sessionCost' | transloco">
              {{ money(sessionCost()) }}
            </span>
          }
        </div>
      </div>
    </div>

    @if (editingBlockId()) {
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
        (click)="closeTextBlockEditor()"
        (keydown.escape)="closeTextBlockEditor()"
      >
        <div
          class="flex h-[70vh] w-[46rem] max-w-full flex-col overflow-hidden glass-pop rounded-2xl shadow-2xl"
          (click)="$event.stopPropagation()"
        >
          <header
            class="flex shrink-0 items-center justify-between border-b border-white/5 px-5 py-3"
          >
            <h3 class="text-sm font-semibold text-white">
              {{ 'composer.textBlockTitle' | transloco }}
            </h3>
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-full text-mist/50 transition-colors hover:bg-white/5 hover:text-white"
              (click)="closeTextBlockEditor()"
            >
              ✕
            </button>
          </header>
          <textarea
            #blockTextarea
            class="field-flush min-h-0 flex-1 resize-none px-5 py-4 font-mono text-sm text-white"
          ></textarea>
          <footer
            class="flex shrink-0 items-center justify-between gap-3 border-t border-white/5 px-5 py-3"
          >
            <span class="text-xs text-mist/40">{{ 'composer.textBlockHint' | transloco }}</span>
            <div class="flex gap-2">
              <button
                type="button"
                class="rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5"
                (click)="closeTextBlockEditor()"
              >
                {{ 'composer.textBlockCancel' | transloco }}
              </button>
              <button
                type="button"
                class="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-ink transition-colors hover:bg-accent/90"
                (click)="saveTextBlock()"
              >
                {{ 'composer.textBlockSave' | transloco }}
              </button>
            </div>
          </footer>
        </div>
      </div>
    }

    @if (previewAttachment(); as preview) {
      <app-attachment-preview
        [attachment]="preview"
        [editable]="true"
        (closed)="previewAttachment.set(null)"
        (applied)="onImageAnnotated(preview, $event)"
      />
    }
  `,
})
export class Composer {
  protected readonly workspace = inject(WorkspaceService);
  private readonly queue = inject(MessageQueueService);
  protected readonly settings = inject(SettingsService);
  /** The configured chat keys, for the hint below the input. */
  protected readonly hintKeys = computed(() => {
    const settings = this.settings.settings();
    const label = (id: HotkeyAction) => displayHotkey(hotkeyBindings(settings, id)[0]);
    return {
      send: label('chatSend'),
      newLine: label('chatNewLine'),
      stop: label('chatStop'),
      recall: label('chatRecallPrompt'),
      toggleMode: label('chatToggleMode'),
    };
  });
  protected readonly modelsService = inject(ModelsService);
  protected readonly providers = inject(ProvidersService);
  private readonly editorDom = inject(ComposerEditorService);

  protected readonly reasoningOptions = REASONING_OPTIONS;
  protected readonly providerPresets = PROVIDER_PRESETS;
  protected readonly circumference = CONTEXT_CIRCUMFERENCE;
  readonly composing = output<boolean>();
  /** `/revert` asks to take the session back to this prompt, its latest one. */
  readonly revertRequested = output<Message>();
  protected readonly draft = signal('');
  protected readonly attachments = signal<MessageAttachment[]>([]);
  protected readonly previewAttachment = signal<MessageAttachment | null>(null);
  protected readonly mentions = signal<Mention[]>([]);
  protected readonly attachmentError = signal<string | null>(null);
  protected readonly dragging = signal(false);
  protected readonly modelOpen = signal(false);
  protected readonly providerOpen = signal(false);
  protected readonly modeOpen = signal(false);
  protected readonly reasoningOpen = signal(false);
  /**
   * How much room the toolbar has. It stays on one row by dropping labels:
   * a tight one shows its buttons as icons and the provider as its mark, and
   * only a roomy one spells out the routing.
   */
  protected readonly toolbarSpace = signal<'tight' | 'normal' | 'roomy'>('normal');
  protected readonly actionButtonClass = computed(() =>
    this.toolbarSpace() === 'tight' ? 'w-8' : 'min-w-24 px-4',
  );
  /** Automatic routing is its mark alone until the row is roomy; a chosen one keeps a short name. */
  protected readonly routingLabelClass = computed(() => {
    if (this.toolbarSpace() === 'roomy') {
      return 'max-w-40 truncate';
    }
    return this.provider() === 'auto' ? 'sr-only' : 'max-w-20 truncate';
  });
  protected readonly mentionOpen = signal(false);
  protected readonly mentionIndex = signal(0);
  protected readonly mentionKind = signal<MentionKind | null>(null);
  protected readonly mentionTerm = signal('');
  protected readonly mentionItems = signal<MentionItem[]>([]);
  /**
   * What the editor holds of a slash command: the start of a name (`command`
   * is `null`), or a picker command and the term typed after it.
   */
  private readonly slash = signal<{ command: SlashCommand | null; term: string } | null>(null);
  private readonly slashIndex = signal(0);
  /** The chat box's own commands and one for each prompt the user wrote, by name. */
  private readonly slashCommands = computed<SlashCommand[]>(() => {
    const prompts = promptCommands(this.settings.settings()?.userSystemPrompts ?? [])
      .filter(({ prompt }) => prompt.prompt.trim())
      .map(({ prompt, name }): SlashCommand => ({ name, kind: 'prompt', prompt }));
    return [...CHAT_BOX_SLASH_COMMANDS, ...prompts].sort((a, b) => a.name.localeCompare(b.name));
  });
  protected readonly slashItems = computed<SlashItem[]>(() => {
    const slash = this.slash();
    if (!slash) {
      return [];
    }
    if (!slash.command) {
      return this.slashCommands()
        .filter((entry) => entry.name.startsWith(slash.term))
        .map((entry) => ({
          id: entry.name,
          label: `/${entry.name}`,
          detail: entry.prompt
            ? this.transloco.translate('composer.commandPrompt', { name: entry.prompt.name })
            : this.transloco.translate(
                entry.name === REVERT_COMMAND ? this.revertHint() : (entry.hint ?? ''),
              ),
          command: true,
          current: false,
          select: () => this.selectCommand(entry),
        }));
    }
    const words = slash.term.toLowerCase().split(/\s+/).filter(Boolean);
    return this.slashChoices(slash.command.name)
      .filter((choice) => {
        const text = `${choice.label} ${choice.search}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .slice(0, SLASH_MODEL_ROWS)
      .map((choice) => ({ ...choice, command: false, select: () => this.choose(choice) }));
  });
  /** The providers that serve the model are still being fetched for `/provider`. */
  protected readonly slashLoading = computed(
    () =>
      this.slash()?.command?.name === 'provider' &&
      this.isOpenRouterModel() &&
      !!this.modelsService.endpointsLoading()[this.model()],
  );
  /** A picker stays open with a note when it has nothing to list. */
  protected readonly slashOpen = computed(
    () => this.slashItems().length > 0 || !!this.slash()?.command,
  );
  /** The highlighted row, also when the list got shorter under it. */
  protected readonly slashActive = computed(() =>
    Math.max(0, Math.min(this.slashIndex(), this.slashItems().length - 1)),
  );
  /** Why a picker lists nothing, as a translation key. */
  protected readonly slashNotice = computed(() => {
    switch (this.slash()?.command?.name) {
      case 'effort':
        return this.supportsReasoning() ? 'composer.mentionNoResults' : 'composer.commandNoEffort';
      case 'provider':
        return this.isOpenRouterModel() ? 'composer.mentionNoResults' : 'composer.commandNoProvider';
      case 'model':
        return this.modelsService.models().length > 0
          ? 'composer.mentionNoResults'
          : 'composer.noModels';
      default:
        return 'composer.mentionNoResults';
    }
  });
  protected readonly textBlocks = signal<TextBlock[]>([]);
  protected readonly editingBlockId = signal<string | null>(null);
  protected readonly blockDraft = signal('');

  private readonly workspaceEntries = signal<WorkspaceEntry[]>([]);
  private readonly catalog = inject(CapabilityCatalogService);
  private readonly sideQuestions = inject(SideQuestionService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private catalogRefreshedFor: MentionKind | null = null;
  private mentionQuery: MentionQuery | null = null;
  /** The project whose files `workspaceEntries` lists. */
  private loadedEntriesFor = '';
  /** The project whose files were read again for the picker that is open. */
  private entriesRefreshedFor: string | null = null;
  /** The session whose draft and attachments the chat box holds. */
  private lastSessionId: string | null = null;
  /** The editor as `restore` brings it back, pills included; see `serialize`. */
  private saved = '';
  private lastComposerFocusNonce = this.workspace.composerFocusNonce();
  private readonly pendingEditorText = signal<string | null>(null);

  private readonly transloco = inject(TranslocoService);

  private readonly cardRef = viewChild<ElementRef<HTMLDivElement>>('card');
  private readonly editorRef = viewChild<ElementRef<HTMLDivElement>>('editor');
  private readonly fileInputRef = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly blockTextareaRef = viewChild<ElementRef<HTMLTextAreaElement>>('blockTextarea');
  private readonly slashMenuRef = viewChild<ElementRef<HTMLElement>>('slashMenu');

  private readonly modelOverride = signal<{ sessionId: string; value: string } | null>(null);
  private readonly reasoningOverride = signal<{ sessionId: string; value: string } | null>(null);
  private readonly providerOverride = signal<{ sessionId: string; value: string } | null>(null);
  private readonly failedIcons = signal<ReadonlySet<string>>(new Set<string>());

  protected readonly model = computed(() => {
    const session = this.workspace.activeAgent();
    const override = this.modelOverride();
    if (session && override?.sessionId === session.id) {
      return override.value;
    }
    return session?.model ?? this.settings.settings()?.defaultModel ?? '';
  });
  protected readonly reasoning = computed(() => {
    const session = this.workspace.activeAgent();
    const override = this.reasoningOverride();
    if (session && override?.sessionId === session.id) {
      return override.value;
    }
    return session?.reasoningEffort ?? this.settings.settings()?.defaultReasoningEffort ?? 'medium';
  });
  protected readonly provider = computed(() => {
    const session = this.workspace.activeAgent();
    const override = this.providerOverride();
    if (session && override?.sessionId === session.id) {
      return override.value;
    }
    return session?.provider || this.providerForModel(this.model()) || 'auto';
  });
  protected readonly selectedModel = computed(() => this.modelsService.byId(this.model()));
  /** Brand of the provider a direct (non-OpenRouter) model is sent to. */
  protected readonly selectedProviderId = computed(() => providerIdOf(this.model()));
  protected readonly selectedProviderName = computed(() =>
    this.providers.name(this.selectedProviderId()),
  );
  /** Only OpenRouter routes a model to one of several upstream providers. */
  protected readonly isOpenRouterModel = computed(
    () => this.selectedProviderId() === OPENROUTER_PROVIDER,
  );
  protected readonly modes = computed(() => this.settings.modes());
  protected readonly selectedMode = computed<Mode | undefined>(() => {
    const modes = this.settings.modes();
    const session = this.workspace.activeAgent();
    return resolveMode(modes, session?.modeId ?? this.settings.settings()?.defaultModeId);
  });
  protected readonly endpoints = computed(() => this.modelsService.endpoints()[this.model()] ?? []);
  protected readonly supportsReasoning = computed(
    () => this.selectedModel()?.supportsReasoning ?? false,
  );
  protected readonly streaming = computed(() => {
    const session = this.workspace.activeAgent();
    return session ? this.workspace.isStreaming(session.id) : false;
  });
  protected readonly canSend = computed(
    () =>
      (this.draft().trim().length > 0 ||
        this.attachments().length > 0 ||
        this.mentions().length > 0) &&
      !!this.model() &&
      !this.streaming(),
  );
  protected readonly canQueue = computed(
    () =>
      (this.draft().trim().length > 0 ||
        this.attachments().length > 0 ||
        this.mentions().length > 0) &&
      !!this.model() &&
      this.streaming(),
  );
  protected readonly queued = computed(() => {
    const session = this.workspace.activeAgent();
    return session ? this.queue.forSession(session.id) : [];
  });
  protected readonly sessionCost = computed(() => this.workspace.activeAgent()?.cost ?? 0);
  protected readonly composingDraft = computed(
    () =>
      this.draft().trim().length > 0 ||
      this.attachments().length > 0 ||
      this.mentions().length > 0 ||
      this.textBlocks().length > 0,
  );
  protected readonly hasPreviousPrompt = computed(() => this.lastPrompt() !== null);
  protected readonly handover = computed(() => {
    const session = this.workspace.activeSession();
    return session ? this.workspace.isHandover(session.id) : false;
  });
  protected readonly canHandover = computed(() => {
    const session = this.workspace.activeSession();
    return (
      !!session &&
      !this.handover() &&
      this.providers.anyConnected() &&
      !this.workspace.isStreaming(session.id) &&
      this.workspace.messagesFor(session.id).length > 0
    );
  });
  protected readonly contextUsage = computed(() => {
    const session = this.workspace.activeAgent();
    if (!session) {
      return null;
    }
    // Prefer the backend's estimate of the next request against the budget the
    // history is trimmed to; after a reload only the last reported usage is left.
    const live = this.workspace.contextUsage()[session.id];
    const hasLive = !!live && live.budgetTokens > 0 && live.usedTokens > 0;
    const used = hasLive ? live.usedTokens : this.lastTurnTokens(session.id);
    const limit = hasLive ? live.budgetTokens : (this.selectedModel()?.contextLength ?? 0);
    if (used <= 0 || limit <= 0) {
      return null;
    }
    const ratio = Math.min(1, used / limit);
    return {
      ratio,
      percent: Math.max(1, Math.round(ratio * 100)),
      color: this.usageColor(ratio),
      usedLabel: used.toLocaleString(),
      limitLabel: limit.toLocaleString(),
      cached: this.lastCacheRate(session.id),
      breakdown: hasLive
        ? {
            system: formatTokenCount(live.systemTokens),
            history: formatTokenCount(live.historyTokens),
            tools: formatTokenCount(live.toolSchemaTokens),
            toolOutput: formatTokenCount(live.toolOutputTokens),
          }
        : null,
    };
  });
  protected readonly compacting = computed(() => {
    const session = this.workspace.activeSession();
    return session ? this.workspace.isCompacting(session.id) : false;
  });
  protected readonly canCompact = computed(() => this.canHandover() && !this.compacting());
  /** Nudges towards a handover once the context meter turns amber. */
  protected readonly suggestHandover = computed(
    () => (this.contextUsage()?.ratio ?? 0) >= METER_WARN_RATIO && this.canHandover(),
  );
  protected readonly providerLabel = computed(() => {
    const provider = this.provider();
    const endpoint = this.endpoints().find(
      (entry) => entry.slug === provider || entry.slug.split('/')[0] === provider,
    );
    return endpoint?.providerName ?? provider;
  });
  private readonly priceRange = computed(() => {
    const prices = this.endpoints()
      .map((endpoint) => endpoint.promptPricePerM)
      .filter((value) => value > 0);
    if (prices.length === 0) {
      return { min: 0, max: 0 };
    }
    return { min: Math.min(...prices), max: Math.max(...prices) };
  });

  constructor() {
    void this.modelsService.loadProviders();
    afterNextRender(() => {
      const card = this.cardRef()?.nativeElement;
      if (!card || typeof ResizeObserver === 'undefined') {
        return;
      }
      // The chat's width follows the side panels, not the window, so the
      // toolbar is sized from its own box rather than with breakpoints.
      const observer = new ResizeObserver(() => {
        const width = card.clientWidth;
        this.toolbarSpace.set(width < 720 ? 'tight' : width < 840 ? 'normal' : 'roomy');
      });
      observer.observe(card);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
    effect(() => {
      const model = this.model();
      if (model && providerIdOf(model) === OPENROUTER_PROVIDER) {
        untracked(() => void this.modelsService.loadEndpoints(model));
      }
    });
    effect(() => {
      const draft = this.workspace.pendingDraft();
      if (draft !== null) {
        // A draft can arrive together with its session, as the summary of a
        // handover does. The switch comes first, or the draft would be saved
        // as what the previous session held.
        this.syncSession();
        this.setEditorText(draft);
        this.workspace.consumeDraft();
      }
    });
    effect(() => {
      const element = this.blockTextareaRef()?.nativeElement;
      const id = this.editingBlockId();
      if (!element || !id) {
        return;
      }
      const text = this.blockDraft();
      element.value = text;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    });
    effect(() => {
      const editor = this.editorRef()?.nativeElement;
      const insert = this.workspace.pendingComposerInsert();
      if (!editor || !insert) {
        return;
      }
      untracked(() => {
        // The insert is for the session on screen, often one that just opened:
        // its draft is loaded first, or loading it would wipe the pills again.
        this.syncSession();
        this.workspace.consumeComposerInsert();
        this.placeCaretAtEnd(editor);
        if (insert.mention) {
          this.insertPill(insert.mention, null);
        }
        this.addTextBlock(insert.text);
        this.focusInput();
      });
    });
    effect(() => {
      const editor = this.editorRef()?.nativeElement;
      const text = this.pendingEditorText();
      if (!editor || text === null) {
        return;
      }
      untracked(() => {
        this.pendingEditorText.set(null);
        this.setEditorDraft(text);
      });
    });
    effect(() => this.syncSession());
    effect(() => {
      const nonce = this.workspace.composerFocusNonce();
      if (nonce === this.lastComposerFocusNonce) {
        return;
      }
      this.lastComposerFocusNonce = nonce;
      untracked(() => this.focusAtText());
    });
  }

  /**
   * Makes the chat box hold what belongs to the session on screen: what it
   * held goes to the session it showed until now, and the draft and the
   * attachments of the new one come in. Whatever is about to put something
   * into the chat box for the session on screen calls this first: the effects
   * for a pending draft or insert run before the one that follows the session,
   * and what they write must neither be saved for the previous session nor be
   * wiped by loading a draft.
   */
  private syncSession(): void {
    const sessionId = this.workspace.activeAgent()?.id ?? null;
    if (sessionId === this.lastSessionId) {
      return;
    }
    const previous = this.lastSessionId;
    this.lastSessionId = sessionId;
    untracked(() => {
      if (previous !== null) {
        this.workspace.setComposerDraft(previous, this.saved);
        this.workspace.setComposerAttachments(previous, this.attachments());
      }
      this.previewAttachment.set(null);
      this.attachmentError.set(null);
      if (sessionId !== null) {
        const saved = this.workspace.composerDraftFor(sessionId);
        if (this.editorRef()) {
          this.setEditorDraft(saved);
        } else if (saved.length > 0) {
          this.pendingEditorText.set(saved);
        }
      }
      this.attachments.set(
        sessionId !== null ? this.workspace.composerAttachmentsFor(sessionId) : [],
      );
    });
  }

  private persistAttachments(): void {
    const session = this.workspace.activeAgent();
    if (session) {
      this.workspace.setComposerAttachments(session.id, this.attachments());
    }
  }

  protected onEditorInput(): void {
    const { content, mentions, saved } = this.serializeEditor();
    this.draft.set(content);
    this.mentions.set(mentions);
    this.saved = saved;
    const session = this.workspace.activeAgent();
    if (session) {
      // The draft is kept with its pills, so that a mention is still there
      // after another session was on screen.
      this.workspace.setComposerDraft(session.id, saved);
    }
    this.composing.emit(content.trim().length > 0 || mentions.length > 0);
    this.updateMention();
    this.updateCommands();
  }

  /**
   * Opens the slash menu while the editor holds the start of a command name,
   * or a picker command and what was typed after it. Read from the editor
   * itself: the draft is trimmed, so it cannot tell "/btw" from "/btw " with
   * the question about to follow.
   */
  private updateCommands(): void {
    const text = this.editorRef()?.nativeElement.textContent ?? '';
    const name = SLASH_QUERY_RE.exec(text);
    const argument = name ? null : SLASH_ARGUMENT_RE.exec(text);
    const picker = argument ? this.pickerCommand(argument[1]) : undefined;
    if (name) {
      this.slash.set({ command: null, term: name[1].toLowerCase() });
    } else if (argument && picker) {
      this.slash.set({ command: picker, term: argument[2].trim() });
      if (picker.name === 'provider' && this.isOpenRouterModel()) {
        // Already there for the model in use, unless fetching them failed.
        void this.modelsService.loadEndpoints(this.model());
      }
    } else {
      this.slash.set(null);
    }
    // A picker opens on the choice in effect, a typed term on its first match.
    const current = this.slash()?.term ? -1 : this.slashItems().findIndex((item) => item.current);
    this.slashIndex.set(Math.max(0, current));
    this.revealSlashItem();
  }

  private pickerCommand(name: string | undefined): SlashCommand | undefined {
    const wanted = name?.toLowerCase();
    return this.slashCommands().find(
      (entry) => entry.kind === 'picker' && entry.name === wanted,
    );
  }

  /** Scrolls the menu to its highlighted row once that row is rendered. */
  private revealSlashItem(): void {
    if (!this.slashOpen()) {
      return;
    }
    afterNextRender(
      () => {
        const menu = this.slashMenuRef()?.nativeElement;
        const row = menu?.querySelector<HTMLElement>('[aria-selected="true"]');
        if (!menu || !row) {
          return;
        }
        if (row.offsetTop < menu.scrollTop) {
          menu.scrollTop = row.offsetTop;
        } else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) {
          menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
        }
      },
      { injector: this.injector },
    );
  }

  /**
   * Picks a command from the menu. Its name is completed for what follows it;
   * a command that needs nothing more runs once its whole name is typed.
   */
  private selectCommand(command: SlashCommand): void {
    if (!this.editorRef()) {
      return;
    }
    if (command.kind === 'action') {
      this.requestRevert();
      return;
    }
    if (command.kind === 'prompt' && this.slash()?.term === command.name) {
      this.slash.set(null);
      void this.send();
      return;
    }
    this.completeCommand(command.name);
  }

  /** Writes a command's name into the chat box, ready for what follows it. */
  private completeCommand(name: string): void {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return;
    }
    this.setEditorText(`/${name} `);
    this.moveCaretToEnd(editor);
  }

  /** Everything a picker command offers, before a typed term narrows it down. */
  private slashChoices(command: string): SlashChoice[] {
    switch (command) {
      case 'effort':
        if (!this.supportsReasoning()) {
          return [];
        }
        return REASONING_OPTIONS.map((option) => {
          const label = this.transloco.translate(`reasoning.${option}`);
          return {
            id: option,
            label,
            detail: '',
            search: `${option} ${label}`,
            current: option === this.reasoning(),
            apply: () => this.selectReasoning(option),
          };
        });
      case 'mode': {
        const current = this.selectedMode()?.id;
        return this.modes().map((mode) => {
          const planOnly = mode.planOnly ? this.transloco.translate('right.planOnly') : '';
          return {
            id: mode.id,
            label: mode.name,
            detail: [planOnly, this.modeSummary(mode)].filter(Boolean).join(' · '),
            search: `${mode.id} ${planOnly}`,
            current: mode.id === current,
            apply: async () => this.selectMode(mode.id),
          };
        });
      }
      case 'model': {
        const favorites = new Set(this.settings.settings()?.favoriteModels ?? []);
        const current = this.model();
        return [...this.modelsService.models()]
          .sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)))
          .map((model) => {
            const provider = this.providers.name(model.source);
            return {
              id: model.id,
              label: model.name,
              detail: [
                provider,
                this.context(model.contextLength),
                `${this.price(model.promptPricePerM)} / ${this.price(model.completionPricePerM)}`,
              ].join(' · '),
              source: model.source,
              search: `${model.name} ${model.id} ${provider}`,
              current: model.id === current,
              apply: () => this.selectModel(model.id),
            };
          });
      }
      case 'provider': {
        if (!this.isOpenRouterModel()) {
          return [];
        }
        const active = this.provider();
        const choices: SlashChoice[] = [
          {
            id: 'auto',
            label: this.transloco.translate('provider.auto'),
            detail: '',
            icon: AUTO_PROVIDER_ICON,
            iconFilled: true,
            search: 'auto',
            current: active === 'auto',
            apply: () => this.selectAutoProvider(),
          },
          ...PROVIDER_PRESETS.map((preset) => ({
            id: preset.value,
            label: this.transloco.translate(preset.key),
            detail: this.transloco.translate(preset.hint),
            icon: this.presetIcon(preset.value),
            search: preset.value,
            current: active === preset.value,
            apply: () => this.selectPreset(preset.value),
          })),
        ];
        // Every endpoint as in the provider menu, with its price, speed and health.
        for (const endpoint of this.endpoints()) {
          const value = endpoint.slug.split('/')[0] || endpoint.providerName;
          choices.push({
            id: `${endpoint.slug}|${endpoint.name}`,
            label: endpoint.providerName,
            detail: '',
            endpoint,
            search: `${endpoint.providerName} ${endpoint.slug} ${endpoint.quantization ?? ''}`,
            current: active === value || active === endpoint.slug,
            apply: () => this.selectProvider(endpoint),
          });
        }
        return choices;
      }
      default:
        return [];
    }
  }

  /** Applies a picker's choice and empties the chat box for the next prompt. */
  private choose(choice: SlashChoice): void {
    this.clearText();
    void choice.apply();
  }

  /** Empties the editor and keeps what is attached. */
  private clearText(): void {
    const session = this.workspace.activeAgent();
    if (session) {
      this.workspace.clearComposerDraft(session.id);
    }
    this.setEditorText('');
    this.focusInput();
  }

  /** The prompt of "Your prompts" that a draft calls with its slash command. */
  private calledPrompt(draft: string): UserSystemPrompt | undefined {
    const name = SLASH_DRAFT_RE.exec(draft.trimStart())?.[1].toLowerCase();
    return this.slashCommands().find((entry) => entry.kind === 'prompt' && entry.name === name)
      ?.prompt;
  }

  /**
   * Handles a draft that still starts with `/revert` or a picker command, for
   * example after Escape closed the menu: the one runs, the other gets its
   * choices back. Reports whether it did; the line of such a command is not
   * sent to the agent as a prompt.
   */
  private runOwnCommand(): boolean {
    const name = SLASH_DRAFT_RE.exec(this.draft().trimStart())?.[1].toLowerCase();
    if (name === REVERT_COMMAND) {
      this.requestRevert();
      return true;
    }
    if (!this.pickerCommand(name)) {
      return false;
    }
    this.updateCommands();
    return this.slashOpen();
  }

  /** The prompt `/revert` goes back to: the latest one of the session shown. */
  private lastUserMessage(): Message | null {
    const session = this.workspace.activeAgent();
    const messages = session ? this.workspace.messagesFor(session.id) : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') {
        return messages[index];
      }
    }
    return null;
  }

  /** What the menu says about `/revert`: what it does, or why it cannot run now. */
  private revertHint(): string {
    if (this.streaming()) {
      return 'composer.commandRevertRunning';
    }
    return this.lastUserMessage() ? 'composer.commandRevert' : 'composer.commandRevertNone';
  }

  /**
   * Asks the chat to take the session back to its latest prompt, which the
   * user confirms there. While that cannot be done, the command stays in the
   * chat box with the menu saying why.
   */
  private requestRevert(): void {
    const target = this.streaming() ? null : this.lastUserMessage();
    const editor = this.editorRef()?.nativeElement;
    if (target) {
      this.clearText();
      this.revertRequested.emit(target);
    } else if (editor) {
      this.setEditorText(`/${REVERT_COMMAND}`);
      this.moveCaretToEnd(editor);
    }
  }

  protected onCaretMove(): void {
    if (this.mentionOpen()) {
      this.updateMention();
    }
  }

  private focusInput(): void {
    this.editorRef()?.nativeElement.focus();
  }

  /**
   * Focuses the editor for typing on. A caret that would land in front of
   * text put there meanwhile, such as a prompt a revert brought back, goes to
   * the end of it instead.
   */
  private focusAtText(): void {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return;
    }
    editor.focus();
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    const atStart =
      !selection ||
      selection.rangeCount === 0 ||
      (selection.isCollapsed &&
        selection.anchorOffset === 0 &&
        (node === editor || node === editor.firstChild));
    if (atStart && editor.textContent) {
      this.moveCaretToEnd(editor);
    }
  }

  /** Moves the caret to the end of the editor unless it already is inside it. */
  private placeCaretAtEnd(editor: HTMLElement): void {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
      return;
    }
    this.moveCaretToEnd(editor);
  }

  private moveCaretToEnd(editor: HTMLElement): void {
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  private setEditorText(text: string): void {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return;
    }
    editor.textContent = text;
    this.textBlocks.set([]);
    this.onEditorInput();
  }

  /**
   * Fills the editor from a draft as `onEditorInput` saves it: its text, and
   * its mentions and pasted blocks as the pills they were.
   */
  private setEditorDraft(saved: string): void {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return;
    }
    const blocks: TextBlock[] = [];
    this.editorDom.restore(editor, saved, (pill) => {
      if ('mention' in pill) {
        return this.createPill(pill.mention);
      }
      const block: TextBlock = { id: this.newId('text-block'), text: pill.block };
      blocks.push(block);
      return this.createTextBlockPill(block);
    });
    this.textBlocks.set(blocks);
    this.onEditorInput();
  }

  private serializeEditor(): { content: string; mentions: Mention[]; saved: string } {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return { content: '', mentions: [], saved: '' };
    }
    return this.editorDom.serialize(editor, this.textBlocks());
  }

  private detectQuery(): MentionQuery | null {
    return this.editorDom.detectQuery();
  }

  private createPill(mention: Mention): HTMLSpanElement {
    return this.editorDom.createPill(
      mention,
      this.mentionIcon(mention.kind),
      this.transloco.translate('composer.removeMention'),
      (pill) => this.removePill(pill),
    );
  }

  private insertPill(mention: Mention, query: MentionQuery | null): void {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return;
    }
    this.editorDom.insertPill(editor, query, this.createPill(mention), () => this.onEditorInput());
  }

  private replaceQuery(text: string, query: MentionQuery): void {
    this.editorDom.replaceQuery(text, query, () => {
      this.focusInput();
      this.onEditorInput();
    });
  }

  private removePill(pill: HTMLElement): void {
    this.editorDom.removePill(pill, () => {
      this.onEditorInput();
      this.focusInput();
    });
  }

  private wordCount(text: string): number {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }

  private newId(prefix: string): string {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private addTextBlock(text: string): void {
    const block: TextBlock = { id: this.newId('text-block'), text };
    this.textBlocks.update((list) => [...list, block]);
    this.insertTextBlockPill(block);
  }

  private createTextBlockPill(block: TextBlock): HTMLSpanElement {
    return this.editorDom.createTextBlockPill(
      block,
      this.blockLabel(block.text),
      this.transloco.translate('composer.textBlockRemove'),
      (id) => this.openTextBlockEditor(id),
      (id, pill) => this.removeTextBlock(id, pill),
    );
  }

  private insertTextBlockPill(block: TextBlock): void {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return;
    }
    this.editorDom.insertTextBlockPill(editor, this.createTextBlockPill(block), () =>
      this.onEditorInput(),
    );
  }

  private blockLabel(text: string): string {
    return this.transloco.translate('composer.textBlockWords', { count: this.wordCount(text) });
  }

  protected openTextBlockEditor(id: string): void {
    const block = this.textBlocks().find((entry) => entry.id === id);
    if (!block) {
      return;
    }
    this.blockDraft.set(block.text);
    this.editingBlockId.set(id);
  }

  protected closeTextBlockEditor(): void {
    this.editingBlockId.set(null);
    this.blockDraft.set('');
  }

  protected saveTextBlock(): void {
    const id = this.editingBlockId();
    if (!id) {
      return;
    }
    const text = this.blockTextareaRef()?.nativeElement.value ?? this.blockDraft();
    this.textBlocks.update((list) =>
      list.map((entry) => (entry.id === id ? { ...entry, text } : entry)),
    );
    const editor = this.editorRef()?.nativeElement;
    const pill = editor?.querySelector<HTMLElement>(`[data-text-block-id="${id}"]`);
    if (pill) {
      const label = pill.querySelector('.text-block-pill-label');
      if (label) {
        label.textContent = this.blockLabel(text);
      }
      pill.title = text.slice(0, 200);
    }
    this.closeTextBlockEditor();
    this.onEditorInput();
    this.focusInput();
  }

  protected removeTextBlock(id: string, pill?: HTMLElement): void {
    const editor = this.editorRef()?.nativeElement;
    const element =
      pill ?? editor?.querySelector<HTMLElement>(`[data-text-block-id="${id}"]`) ?? null;
    if (element) {
      this.editorDom.removePill(element, () => {});
    }
    this.textBlocks.update((list) => list.filter((entry) => entry.id !== id));
    if (this.editingBlockId() === id) {
      this.closeTextBlockEditor();
    }
    this.onEditorInput();
    this.focusInput();
  }

  private insertLineBreak(): void {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return;
    }
    this.editorDom.insertLineBreak(editor);
    this.onEditorInput();
  }

  // Inserts a node at the current caret when it is inside `editor`, otherwise
  // appends it. Replaces the deprecated `document.execCommand` path.
  private insertAtCaret(editor: HTMLElement, node: Node): void {
    this.editorDom.insertAtCaret(editor, node);
  }

  protected openFilePicker(): void {
    this.fileInputRef()?.nativeElement.click();
  }

  protected onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      void this.addFiles(input.files);
    }
    input.value = '';
  }

  protected onPaste(event: ClipboardEvent): void {
    const files = event.clipboardData?.files;
    if (files && files.length > 0) {
      event.preventDefault();
      void this.addFiles(files);
      return;
    }
    const text = event.clipboardData?.getData('text/plain');
    if (text) {
      event.preventDefault();
      const limit = this.settings.settings()?.pasteWordLimit ?? 0;
      if (limit > 0 && this.wordCount(text) > limit) {
        this.addTextBlock(text);
        return;
      }
      const editor = this.editorRef()?.nativeElement;
      if (editor) {
        this.insertAtCaret(editor, document.createTextNode(text));
      }
      this.onEditorInput();
      return;
    }
    // WebKitGTK (Linux) hands a copied image to the page neither as a file nor
    // as a clipboard item; its only way in is the browser's own paste, which
    // drops it into the editor as a full-size <img> that is never sent. Let
    // that paste happen, then move the image into the attachments.
    setTimeout(() => this.adoptPastedImages());
  }

  /** Turns images pasted straight into the editor into attachments. */
  private adoptPastedImages(): void {
    const editor = this.editorRef()?.nativeElement;
    const images = editor ? Array.from(editor.querySelectorAll('img')) : [];
    if (images.length === 0) {
      return;
    }
    images.forEach((image) => image.remove());
    this.onEditorInput();
    void Promise.all(images.map((image) => imageToFile(image))).then(async (files) => {
      const pasted = files.filter((file): file is File => file !== null);
      await this.addFiles(pasted);
      if (pasted.length < images.length) {
        this.attachmentError.set('composer.attachmentUnsupported');
      }
    });
  }

  protected onDragOver(event: DragEvent): void {
    if (!event.dataTransfer) {
      return;
    }
    event.preventDefault();
    this.dragging.set(true);
  }

  protected onDragLeave(event: DragEvent): void {
    const next = event.relatedTarget as Node | null;
    const current = event.currentTarget as Node | null;
    if (!next || !current || !current.contains(next)) {
      this.dragging.set(false);
    }
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      void this.addFiles(files);
    }
  }

  protected removeAttachment(id: string): void {
    this.attachments.update((list) => list.filter((attachment) => attachment.id !== id));
    this.attachmentError.set(null);
    this.persistAttachments();
  }

  protected onImageAnnotated(source: MessageAttachment, edited: MessageAttachment): void {
    this.attachments.update((list) =>
      list.map((attachment) => (attachment.id === source.id ? edited : attachment)),
    );
    this.previewAttachment.set(null);
    this.persistAttachments();
  }

  protected preview(attachment: MessageAttachment): string {
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

  private async addFiles(files: Iterable<File>): Promise<void> {
    const selected = Array.from(files);
    if (selected.length === 0) {
      return;
    }
    this.attachmentError.set(null);
    // Reading a file takes a while: by then another paste may have added
    // files, a chip may be gone or another session may be on screen. So the
    // list is read where it is used, and the files stay with this session.
    const sessionId = this.workspace.activeAgent()?.id ?? null;
    const held = (): MessageAttachment[] => {
      this.syncSession();
      return sessionId === null || sessionId === this.lastSessionId
        ? this.attachments()
        : this.workspace.composerAttachmentsFor(sessionId);
    };
    const accepted: MessageAttachment[] = [];
    let unsupported = false;
    let tooLarge = false;
    let tooMany = false;
    for (const file of selected) {
      if (held().length + accepted.length >= MAX_ATTACHMENTS) {
        tooMany = true;
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        tooLarge = true;
        continue;
      }
      const attachment = await this.readAttachment(file);
      if (!attachment) {
        unsupported = true;
        continue;
      }
      accepted.push(attachment);
    }
    const current = held();
    const room = Math.max(0, MAX_ATTACHMENTS - current.length);
    if (accepted.length > room) {
      // A paste that overlapped this one took the room that was left.
      tooMany = true;
    }
    const added = [...current, ...accepted.slice(0, room)];
    if (sessionId !== null && sessionId !== this.lastSessionId) {
      // Another session is on screen by now. The files wait with the one they
      // were added to, and what went wrong with them is not this one's news.
      if (added.length > current.length) {
        this.workspace.setComposerAttachments(sessionId, added);
      }
      return;
    }
    if (added.length > current.length) {
      this.attachments.set(added);
      this.persistAttachments();
    }
    if (tooMany) {
      this.attachmentError.set('composer.attachmentTooMany');
    } else if (tooLarge) {
      this.attachmentError.set('composer.attachmentTooLarge');
    } else if (unsupported) {
      this.attachmentError.set('composer.attachmentUnsupported');
    }
  }

  private attachmentKind(file: File): MessageAttachment['kind'] | null {
    const mime = file.type.toLowerCase();
    if (mime.startsWith('image/')) {
      return 'image';
    }
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (mime === 'application/pdf' || extension === 'pdf') {
      return 'pdf';
    }
    if (mime.startsWith('text/') || TEXT_MIME_TYPES.has(mime) || TEXT_EXTENSIONS.has(extension)) {
      return 'text';
    }
    return null;
  }

  private readAttachment(file: File): Promise<MessageAttachment | null> {
    const kind = this.attachmentKind(file);
    if (!kind) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const id =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        if (kind === 'image' || kind === 'pdf') {
          const comma = result.indexOf(',');
          const data = comma >= 0 ? result.slice(comma + 1) : result;
          const mimeType =
            /^data:([^;,]+)/.exec(result)?.[1] ??
            (file.type || (kind === 'pdf' ? 'application/pdf' : 'image/png'));
          resolve({
            id,
            name: file.name || (kind === 'pdf' ? 'document.pdf' : 'image'),
            mimeType,
            size: file.size,
            kind,
            lines: null,
            data,
          });
          return;
        }
        resolve({
          id,
          name: file.name,
          mimeType: file.type || 'text/plain',
          size: file.size,
          kind,
          lines: result.length === 0 ? 0 : result.split('\n').length,
          data: result,
        });
      };
      if (kind === 'image' || kind === 'pdf') {
        reader.readAsDataURL(file);
      } else {
        reader.readAsText(file);
      }
    });
  }

  protected closeMenus(): void {
    if (this.menuOpen()) {
      this.modelOpen.set(false);
      this.providerOpen.set(false);
      this.modeOpen.set(false);
      this.reasoningOpen.set(false);
      this.focusInput();
    }
  }

  private menuOpen(): boolean {
    return this.modelOpen() || this.providerOpen() || this.modeOpen() || this.reasoningOpen();
  }

  private updateMention(): void {
    const query = this.detectQuery();
    if (!query) {
      this.closeMention();
      return;
    }
    this.mentionQuery = query;

    if (!query.hasColon) {
      const kinds = MENTION_KINDS.filter((kind) => kind.startsWith(query.kindPrefix));
      if (kinds.length === 0) {
        this.closeMention();
        return;
      }
      this.mentionKind.set(null);
      this.mentionTerm.set(query.kindPrefix);
      this.mentionItems.set(
        kinds.map((kind) => ({
          kind,
          value: '',
          label: this.kindLabel(kind),
          sublabel: this.kindHint(kind),
        })),
      );
      this.mentionIndex.set(0);
      this.mentionOpen.set(true);
      return;
    }

    const kind = query.kindPrefix as MentionKind;
    if (!MENTION_KINDS.includes(kind)) {
      this.closeMention();
      return;
    }
    this.mentionKind.set(kind);
    this.mentionTerm.set(query.term);
    this.mentionItems.set(this.filterMentionItems(kind, query.term));
    this.mentionIndex.set(0);
    this.mentionOpen.set(true);
    void this.loadMentionData(kind);
  }

  private async loadMentionData(kind: MentionKind): Promise<void> {
    if (kind === 'file' || kind === 'directory') {
      const project = this.workspace.activeProject();
      if (!project || this.entriesRefreshedFor === project.id) {
        return;
      }
      // The agent adds and deletes files, so they are read again once each
      // time the picker opens; the list from before shows meanwhile.
      this.entriesRefreshedFor = project.id;
      if (this.loadedEntriesFor !== project.id) {
        // Unless it lists the files of another project.
        this.loadedEntriesFor = '';
        this.workspaceEntries.set([]);
        this.mentionItems.set(this.filterMentionItems(kind, this.mentionTerm()));
      }
      let entries: WorkspaceEntry[];
      try {
        entries = await api.listWorkspaceEntries(project.id);
      } catch {
        // Whatever is listed stays, and the next keystroke tries again.
        if (this.entriesRefreshedFor === project.id) {
          this.entriesRefreshedFor = null;
        }
        return;
      }
      // A slow answer for a project that is no longer the one on screen.
      if (this.workspace.activeProject()?.id !== project.id) {
        return;
      }
      this.loadedEntriesFor = project.id;
      this.workspaceEntries.set(entries);
      const open = this.mentionKind();
      if (open === 'file' || open === 'directory') {
        this.mentionItems.set(this.filterMentionItems(open, this.mentionTerm()));
      }
      return;
    }
    if ((kind !== 'skill' && kind !== 'mcp') || this.catalogRefreshedFor === kind) {
      return;
    }
    // Skills and servers can be added on disk outside pumr, so re-scan once each
    // time the picker opens; the cached list shows immediately meanwhile.
    this.catalogRefreshedFor = kind;
    await this.catalog.refresh();
    if (this.mentionKind() === kind) {
      this.mentionItems.set(this.filterMentionItems(kind, this.mentionTerm()));
    }
  }

  private filterMentionItems(kind: MentionKind, term: string): MentionItem[] {
    const needle = term.toLowerCase();
    const limit = 60;
    switch (kind) {
      case 'file':
      case 'directory':
        return this.workspaceEntries()
          .filter((entry) => entry.kind === kind)
          .filter((entry) => needle === '' || entry.path.toLowerCase().includes(needle))
          .slice(0, limit)
          .map((entry) => ({
            kind,
            value: entry.path,
            label: entry.path.split('/').pop() ?? entry.path,
            sublabel: entry.path,
          }));
      case 'skill':
      case 'mcp':
        return searchCapabilities(
          kind === 'skill' ? this.catalog.skills() : this.catalog.mcpServers(),
          term,
        )
          .slice(0, limit)
          .map((item) => ({
            kind,
            value: item.name,
            label: item.name,
            sublabel: item.description ?? item.sources.join(', '),
            prose: kind === 'skill' && item.description !== null,
          }));
      case 'website': {
        const items: MentionItem[] = [];
        const trimmed = term.trim();
        if (/^https?:\/\//i.test(trimmed) || trimmed.includes('.')) {
          items.push({
            kind: 'website',
            value: trimmed,
            label: this.transloco.translate('composer.mentionFetch', { url: trimmed }),
            sublabel: null,
          });
        }
        const allowed = this.settings.settings()?.allowedWebsites ?? [];
        for (const site of allowed) {
          if (needle === '' || site.toLowerCase().includes(needle)) {
            items.push({ kind: 'website', value: site, label: site, sublabel: null });
          }
        }
        return items.slice(0, limit);
      }
      default:
        return [];
    }
  }

  protected selectMention(item: MentionItem): void {
    const query = this.mentionQuery;
    if (item.value === '') {
      if (query) {
        this.replaceQuery(`@${item.kind}:`, query);
      }
      return;
    }
    if (this.mentions().some((entry) => entry.kind === item.kind && entry.value === item.value)) {
      if (query) {
        this.replaceQuery('', query);
      }
      this.closeMention();
      return;
    }
    this.insertPill({ kind: item.kind, value: item.value, label: item.label }, query);
    this.closeMention();
    this.focusInput();
  }

  protected removeMention(mention: Mention): void {
    this.mentions.update((list) =>
      list.filter((entry) => !(entry.kind === mention.kind && entry.value === mention.value)),
    );
    this.focusInput();
  }

  protected moveMention(delta: number): void {
    const items = this.mentionItems();
    if (items.length === 0) {
      return;
    }
    const next = (this.mentionIndex() + delta + items.length) % items.length;
    this.mentionIndex.set(next);
  }

  protected closeMention(): void {
    this.catalogRefreshedFor = null;
    this.entriesRefreshedFor = null;
    this.mentionOpen.set(false);
    this.mentionKind.set(null);
    this.mentionTerm.set('');
    this.mentionItems.set([]);
    this.mentionQuery = null;
  }

  protected mentionEmptyKey(): string {
    return 'composer.mentionNoResults';
  }

  protected mentionIcon(kind: MentionKind): string {
    switch (kind) {
      case 'file':
        return 'M11.5 2.5H5.5A1.5 1.5 0 0 0 4 4v12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 16V7zM11.5 2.5V7H16';
      case 'directory':
        return 'M2.5 5.5A1.5 1.5 0 0 1 4 4h3l2 2h7a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z';
      case 'website':
        return 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM3 10h14M10 3c2 2 2 12 0 14M10 3c-2 2-2 12 0 14';
      case 'skill':
        return 'm10 2 1.6 4.4L16 8l-4.4 1.6L10 14l-1.6-4.4L4 8l4.4-1.6z';
      default:
        return 'M8 3a2 2 0 1 1 4 0v1h2.5a1 1 0 0 1 1 1V8h1a2 2 0 1 1 0 4h-1v2.5a1 1 0 0 1-1 1H12v-1a2 2 0 1 0-4 0v1H5.5a1 1 0 0 1-1-1V12h1a2 2 0 1 0 0-4h-1V5a1 1 0 0 1 1-1H8z';
    }
  }

  private kindLabel(kind: MentionKind): string {
    return this.transloco.translate(`composer.mentionKinds.${kind}.label`);
  }

  private kindHint(kind: MentionKind): string {
    return this.transloco.translate(`composer.mentionKinds.${kind}.hint`);
  }

  private parseMentions(text: string): Mention[] {
    const mentions: Mention[] = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(MENTION_TOKEN_RE)) {
      const key = `${match[1]}:${match[2]}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      mentions.push({ kind: match[1] as MentionKind, value: match[2], label: match[2] });
    }
    return mentions;
  }

  /**
   * Takes mentions typed as `@kind:value` out of a message. Each goes with the
   * one space beside it, as a pill does; everything else stays as typed, the
   * indentation of code included.
   */
  private stripMentions(text: string): string {
    const stripped = text.replace(MENTION_GAP_RE, (match: string, offset: number) => {
      const before = text[offset - 1];
      const after = text[offset + match.length];
      const lineEdge = !before || before === '\n' || !after || after === '\n';
      return lineEdge ? '' : ' ';
    });
    return trimEdges(stripped);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (this.mentionOpen()) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.moveMention(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveMention(-1);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        const items = this.mentionItems();
        if (items.length > 0) {
          event.preventDefault();
          this.selectMention(items[this.mentionIndex()] ?? items[0]);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (this.mentionKind() && this.mentionQuery) {
          this.replaceQuery('', this.mentionQuery);
        }
        this.closeMention();
        return;
      }
    }
    if (this.slashOpen()) {
      const items = this.slashItems();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (items.length > 0) {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          this.slashIndex.set((this.slashActive() + step + items.length) % items.length);
          this.revealSlashItem();
        }
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        // A picker with nothing to pick keeps its line instead of sending it.
        event.preventDefault();
        const item = items[this.slashActive()];
        if (event.key === 'Tab' && item?.command) {
          // Tab only writes the name out, for an argument to follow. Running
          // a command, also one whose whole name is typed, is left to Enter.
          this.completeCommand(item.id);
        } else {
          item?.select();
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.slash.set(null);
        return;
      }
    }
    if (event.key === 'Escape' && this.menuOpen()) {
      this.closeMenus();
      return;
    }
    // Before Stop: closing an answer must never end the turn that is running.
    if (event.key === 'Escape' && this.dismissSideAnswer()) {
      event.preventDefault();
      return;
    }
    const settings = this.settings.settings();
    if (this.streaming() && matchesAction(settings, 'chatStop', event)) {
      event.preventDefault();
      void this.stop();
      return;
    }
    if (!this.composingDraft() && matchesAction(settings, 'chatRecallPrompt', event)) {
      const previous = this.lastPrompt();
      if (previous) {
        event.preventDefault();
        this.recallPrompt(previous);
      }
      return;
    }
    if (this.menuOpen()) {
      return;
    }
    if (matchesAction(settings, 'chatSend', event)) {
      event.preventDefault();
      void this.send();
      return;
    }
    // Any other Enter combination breaks the line rather than letting the
    // editable insert its own block markup.
    if (matchesAction(settings, 'chatNewLine', event) || event.key === 'Enter') {
      event.preventDefault();
      this.insertLineBreak();
    }
  }

  /** The latest prompt typed into this session, for recalling it with ↑. */
  private lastPrompt(): string | null {
    const session = this.workspace.activeAgent();
    if (!session) {
      return null;
    }
    const messages = this.workspace.messagesFor(session.id);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user' && message.content.trim()) {
        return message.content;
      }
    }
    return null;
  }

  private recallPrompt(text: string): void {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return;
    }
    this.setEditorText(text);
    this.moveCaretToEnd(editor);
  }

  protected async send(): Promise<void> {
    if (this.askSideQuestion() || this.runOwnCommand()) {
      return;
    }
    if (this.streaming()) {
      this.enqueue();
      return;
    }
    const args = this.buildArgs();
    if (!args) {
      return;
    }
    // The chat box empties at once, but the backend can still turn the prompt
    // down before it has stored it, for a model without an API key say.
    const saved = this.saved;
    this.clearComposer();
    if (!(await this.workspace.send(args))) {
      this.putBack(args, saved);
    }
    this.focusInput();
  }

  /**
   * Brings back a prompt the backend did not take, pills and attachments
   * included, so that it is not lost: into the chat box when that still shows
   * its session, in front of whatever was typed there since, and else into
   * the draft that session keeps.
   */
  private putBack(args: SendMessageArgs, saved: string): void {
    const attachments = args.attachments ?? [];
    const before = (typed: string): string => [saved, typed].filter(Boolean).join('\n\n');
    this.syncSession();
    if (this.lastSessionId !== args.sessionId) {
      const { sessionId } = args;
      this.workspace.setComposerDraft(
        sessionId,
        before(this.workspace.composerDraftFor(sessionId)),
      );
      this.workspace.setComposerAttachments(sessionId, [
        ...attachments,
        ...this.workspace.composerAttachmentsFor(sessionId),
      ]);
      return;
    }
    this.setEditorDraft(before(this.saved));
    this.attachments.update((list) => [...attachments, ...list]);
    this.persistAttachments();
    const editor = this.editorRef()?.nativeElement;
    if (editor) {
      // Typing goes on behind the prompt, not in front of it.
      this.moveCaretToEnd(editor);
    }
  }

  /**
   * Asks the draft as a side question when it is a `/btw` command and reports
   * whether it was one. That never waits for a running turn, and attachments
   * stay in the chat box for the next prompt.
   */
  private askSideQuestion(): boolean {
    const question = sideQuestionOf(this.draft());
    if (question === null) {
      return false;
    }
    const session = this.workspace.activeAgent();
    const model = this.model();
    if (session && model && question) {
      void this.sideQuestions.ask(session.id, question, model);
      this.clearText();
    }
    return true;
  }

  /** Closes the side answer shown for this session; false when there is none. */
  private dismissSideAnswer(): boolean {
    const session = this.workspace.activeAgent();
    if (!session || !this.sideQuestions.forSession(session.id)) {
      return false;
    }
    this.sideQuestions.dismiss(session.id);
    return true;
  }

  protected enqueue(): void {
    if (this.askSideQuestion() || this.runOwnCommand()) {
      return;
    }
    const args = this.buildArgs();
    if (!args) {
      return;
    }
    this.clearComposer();
    this.queue.enqueue(args);
    this.focusInput();
  }

  protected removeQueued(index: number): void {
    const session = this.workspace.activeAgent();
    if (session) {
      this.queue.remove(session.id, index);
    }
  }

  protected clearQueue(): void {
    const session = this.workspace.activeAgent();
    if (session) {
      this.queue.clear(session.id);
    }
  }

  private buildArgs(): SendMessageArgs | null {
    const session = this.workspace.activeAgent();
    // Already without the blank lines around it; the rest goes out as typed.
    const raw = this.draft();
    const content = this.stripMentions(raw);
    const mentions = [...this.mentions()];
    for (const typed of this.parseMentions(raw)) {
      if (!mentions.some((entry) => entry.kind === typed.kind && entry.value === typed.value)) {
        mentions.push(typed);
      }
    }
    const model = this.model();
    const attachments = this.attachments();
    if (!session || (!content && attachments.length === 0 && mentions.length === 0) || !model) {
      return null;
    }
    // The chat keeps the line as typed; the backend adds the prompt it calls.
    const prompt = this.calledPrompt(content);
    return {
      sessionId: session.id,
      content,
      model,
      reasoningEffort: this.reasoning(),
      provider: !this.isOpenRouterModel() || this.provider() === 'auto' ? null : this.provider(),
      attachments,
      mentions,
      ...(prompt ? { promptId: prompt.id } : {}),
    };
  }

  private clearComposer(): void {
    const session = this.workspace.activeAgent();
    if (session) {
      this.workspace.clearComposerDraft(session.id);
      this.workspace.clearComposerAttachments(session.id);
    }
    this.setEditorText('');
    this.attachments.set([]);
    this.previewAttachment.set(null);
    this.mentions.set([]);
    this.textBlocks.set([]);
    this.attachmentError.set(null);
    this.closeMention();
  }

  protected async stop(): Promise<void> {
    const session = this.workspace.activeAgent();
    if (session) {
      await this.workspace.stop(session.id);
    }
  }

  protected async handoverSession(): Promise<void> {
    await this.workspace.handoverActiveSession();
  }

  protected async compactSession(): Promise<void> {
    await this.workspace.compactActiveSession();
  }

  protected async selectModel(modelId: string): Promise<void> {
    const session = this.workspace.activeAgent();
    const provider = this.providerForModel(modelId) || 'auto';
    this.modelOverride.set(session ? { sessionId: session.id, value: modelId } : null);
    this.providerOverride.set(session ? { sessionId: session.id, value: provider } : null);
    this.modelOpen.set(false);
    this.focusInput();
    if (session) {
      await this.workspace.updateSession({
        sessionId: session.id,
        model: modelId,
        provider: provider === 'auto' ? '' : provider,
      });
    }
  }

  private providerForModel(modelId: string): string {
    return this.settings.settings()?.providerByModel?.[modelId] ?? '';
  }

  private async rememberProvider(modelId: string, value: string): Promise<void> {
    const current = this.settings.settings()?.providerByModel ?? {};
    if (value === 'auto') {
      if (!(modelId in current)) {
        return;
      }
      const next = { ...current };
      delete next[modelId];
      await this.settings.patch({ providerByModel: next });
      return;
    }
    if (current[modelId] === value) {
      return;
    }
    await this.settings.patch({ providerByModel: { ...current, [modelId]: value } });
  }

  protected async selectReasoning(option: string): Promise<void> {
    const session = this.workspace.activeAgent();
    this.reasoningOverride.set(session ? { sessionId: session.id, value: option } : null);
    if (session) {
      await this.workspace.updateSession({ sessionId: session.id, reasoningEffort: option });
    }
  }

  /** Picks a level from the chip's menu and hands the caret back to the chat box. */
  protected pickReasoning(option: string): void {
    this.reasoningOpen.set(false);
    this.focusInput();
    void this.selectReasoning(option);
  }

  protected selectMode(modeId: string): void {
    const session = this.workspace.activeAgent();
    this.modeOpen.set(false);
    this.focusInput();
    if (session) {
      void this.workspace.updateSession({ sessionId: session.id, modeId });
    }
  }

  protected modeSummary(mode: Mode): string {
    if (mode.description.trim()) {
      return mode.description;
    }
    const parts: string[] = [];
    if (mode.systemPrompt.trim()) {
      parts.push(this.transloco.translate('right.modeSystemPrompt'));
    }
    if (mode.userPromptIds.length > 0) {
      parts.push(`${mode.userPromptIds.length} ${this.transloco.translate('right.modePrompts')}`);
    }
    if (mode.mcpServers.length > 0) {
      parts.push(`${mode.mcpServers.length} ${this.transloco.translate('right.modeMcpShort')}`);
    }
    if (mode.skills.length > 0) {
      parts.push(mode.skills.join(', '));
    }
    if (parts.length === 0) {
      parts.push(this.transloco.translate('right.modeBaseOnly'));
    }
    return parts.join(' · ');
  }

  protected toggleProvider(): void {
    const opening = !this.providerOpen();
    if (opening) {
      const model = this.model();
      if (model) {
        void this.modelsService.loadEndpoints(model);
      }
    }
    this.providerOpen.set(opening);
  }

  protected async selectProvider(endpoint: EndpointInfo): Promise<void> {
    const slug = endpoint.slug.split('/')[0] || endpoint.providerName;
    await this.applyProvider(slug);
  }

  protected async selectAutoProvider(): Promise<void> {
    await this.applyProvider('auto');
  }

  protected async selectPreset(value: string): Promise<void> {
    await this.applyProvider(value);
  }

  private async applyProvider(value: string): Promise<void> {
    const session = this.workspace.activeAgent();
    this.providerOverride.set(session ? { sessionId: session.id, value } : null);
    this.providerOpen.set(false);
    this.focusInput();
    const model = this.model();
    if (model) {
      await this.rememberProvider(model, value);
    }
    if (session) {
      await this.workspace.updateSession({
        sessionId: session.id,
        provider: value === 'auto' ? '' : value,
      });
    }
  }

  protected presetKey(value: string): string | null {
    return this.providerPresets.find((preset) => preset.value === value)?.key ?? null;
  }

  protected presetIcon(value: string): string {
    switch (value) {
      case 'auto:throughput':
        return 'M11 2 4 11h5l-1 7 7-9h-5z';
      case 'auto:price':
        return 'M10 3v14M13 6.5H8.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H7';
      default:
        return 'M3 16l4.5-5 3 3L17 7M14 7h3v3';
    }
  }

  protected region(slug: string): string | null {
    const parts = slug.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : null;
  }

  protected providerIcon(slug: string): string | null {
    if (this.failedIcons().has(slug)) {
      return null;
    }
    return this.modelsService.providerIcon(slug);
  }

  protected providerIconError(slug: string): void {
    this.failedIcons.update((set) => new Set(set).add(slug));
  }

  protected initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }

  protected uptime(endpoint: EndpointInfo): number | null {
    return endpoint.uptimeLast30m ?? endpoint.uptimeLast1d ?? null;
  }

  protected uptimeColor(endpoint: EndpointInfo): string {
    const value = this.uptime(endpoint);
    if (value === null) {
      return METER_MUTED;
    }
    if (value >= 99) {
      return METER_GOOD;
    }
    if (value >= 95) {
      return METER_WARN;
    }
    return METER_BAD;
  }

  private priceTier(endpoint: EndpointInfo): number {
    const { min, max } = this.priceRange();
    if (max <= min) {
      return 0;
    }
    return Math.min(1, Math.max(0, (endpoint.promptPricePerM - min) / (max - min)));
  }

  protected priceColor(endpoint: EndpointInfo): string {
    return `hsl(${140 - 140 * this.priceTier(endpoint)} 72% 72%)`;
  }

  protected priceBackground(endpoint: EndpointInfo): string {
    return `hsl(${140 - 140 * this.priceTier(endpoint)} 72% 50% / 0.16)`;
  }

  protected readonly price = formatModelPrice;
  protected readonly context = formatModelContext;

  protected money(value: number): string {
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  }

  private lastTurnTokens(sessionId: string): number {
    const messages = this.workspace.messagesFor(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      // What a request used before a compaction says nothing about the context now.
      if (message.role === 'compaction') {
        return 0;
      }
      if (message.role === 'assistant' && message.promptTokens > 0) {
        return message.promptTokens + message.completionTokens;
      }
    }
    return 0;
  }

  /** Share of the last request's input that came from the provider's cache, in percent. */
  private lastCacheRate(sessionId: string): number | null {
    const messages = this.workspace.messagesFor(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'assistant' && message.promptTokens > 0) {
        return Math.round((message.cachedTokens / message.promptTokens) * 100);
      }
    }
    return null;
  }

  private usageColor(ratio: number): string {
    if (ratio >= METER_BAD_RATIO) {
      return METER_BAD;
    }
    if (ratio >= METER_WARN_RATIO) {
      return METER_WARN;
    }
    return 'var(--color-accent)';
  }
}
