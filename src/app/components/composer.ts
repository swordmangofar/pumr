import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  EndpointInfo,
  Mention,
  MentionKind,
  MessageAttachment,
  Mode,
  WorkspaceEntry,
} from '../core/models';
import { api } from '../core/api';
import { ModelsService } from '../core/models.service';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';

const REASONING_OPTIONS = ['off', 'low', 'medium', 'high'];

const MENTION_KINDS: MentionKind[] = ['file', 'directory', 'website', 'skill', 'mcp'];

const MENTION_TOKEN_RE = /@(file|directory|website|skill|mcp):([^\s]+)/g;

interface MentionItem {
  kind: MentionKind;
  value: string;
  label: string;
  sublabel: string | null;
}

interface MentionQuery {
  node: Text;
  start: number;
  end: number;
  kindPrefix: string;
  hasColon: boolean;
  term: string;
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

@Component({
  selector: 'app-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [TranslocoPipe],
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
    `,
  ],
  template: `
    <div class="px-4 pt-2 pb-3">
      <div
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
                class="relative flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 py-1.5 pr-7 pl-1.5"
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
                    PDF
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
                  (click)="removeAttachment(attachment.id)"
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
                    <span class="block truncate font-mono text-xs text-mist/40">{{
                      item.sublabel
                    }}</span>
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

        <div
          #editor
          class="composer-editor block max-h-[min(45vh,22rem)] min-h-[5.5rem] w-full overflow-y-auto bg-transparent px-4 pt-3.5 pr-3 pb-1 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-white outline-none"
          contenteditable="true"
          role="textbox"
          aria-multiline="true"
          enterkeyhint="send"
          [attr.aria-label]="'chat.placeholder' | transloco"
          [attr.data-placeholder]="'chat.placeholder' | transloco"
          (input)="onEditorInput()"
          (keydown)="onKeydown($event)"
          (keyup.arrowleft)="onCaretMove()"
          (keyup.arrowright)="onCaretMove()"
          (click)="onCaretMove()"
          (paste)="onPaste($event)"
        ></div>

        <div class="flex items-end justify-between gap-2 border-t border-white/5 px-4 py-2">
          <div class="flex min-w-0 flex-wrap items-center gap-1">
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded-full text-mist/50 transition-colors hover:bg-white/5 hover:text-white"
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
            <!-- Model picker -->
            <div>
              <button
                type="button"
                class="flex h-7 items-center gap-1.5 rounded-full px-2 text-xs text-mist/60 transition-colors hover:bg-white/5 hover:text-white"
                [attr.aria-expanded]="modelOpen()"
                [attr.aria-controls]="modelOpen() ? 'composer-model-menu' : null"
                (click)="modelOpen.set(!modelOpen())"
                (keydown.escape)="closeMenus()"
              >
                <span class="max-w-56 truncate">{{
                  selectedModel()?.name ?? ('composer.noModels' | transloco)
                }}</span>
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
                <div
                  class="absolute bottom-full left-0 z-40 mb-2 flex max-h-[min(24rem,50vh)] w-[min(30rem,100%)] flex-col overflow-hidden glass-pop rounded-2xl shadow-2xl"
                  id="composer-model-menu"
                  (keydown.escape)="closeMenus()"
                >
                  <input
                    class="field-flush px-4 py-2.5 text-sm"
                    [value]="modelFilter()"
                    [placeholder]="'composer.searchModel' | transloco"
                    [attr.aria-label]="'composer.searchModel' | transloco"
                    (input)="onFilter($event)"
                    autofocus
                  />
                  <div class="min-h-0 flex-1 overflow-y-auto">
                    @for (model of filteredModels(); track model.id) {
                      <div
                        class="flex items-stretch border-b border-white/5 transition-colors hover:bg-white/5"
                        [class]="model.id === selectedModel()?.id ? 'bg-accent/10' : ''"
                      >
                        <button
                          type="button"
                          class="min-w-0 flex-1 px-4 py-2.5 text-left"
                          (click)="selectModel(model.id)"
                        >
                          <div class="flex items-center justify-between gap-3">
                            <span class="truncate text-sm text-white">{{ model.name }}</span>
                            <span class="shrink-0 text-xs text-mist/40">
                              {{ price(model.promptPricePerM) }} /
                              {{ price(model.completionPricePerM) }}
                            </span>
                          </div>
                          <div class="mt-1 flex items-center gap-2 text-xs text-mist/30">
                            <span class="truncate">{{ model.id }}</span>
                            <span
                              class="shrink-0"
                              [attr.title]="
                                ('provider.context' | transloco) +
                                ': ' +
                                model.contextLength.toLocaleString()
                              "
                              >{{ context(model.contextLength) }}</span
                            >
                            @if (model.supportsReasoning) {
                              <span
                                class="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-accent"
                                >reasoning</span
                              >
                            }
                            @if (model.supportsVision) {
                              <span
                                class="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-mist/60"
                                >vision</span
                              >
                            }
                            @if (model.supportsTools) {
                              <span
                                class="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300"
                                >tools</span
                              >
                            }
                          </div>
                        </button>
                        <button
                          type="button"
                          class="flex shrink-0 items-center px-3 transition-colors"
                          [class]="
                            isFavorite(model.id)
                              ? 'text-amber-300 hover:text-amber-200'
                              : 'text-mist/40 hover:text-amber-200'
                          "
                          [attr.aria-label]="
                            (isFavorite(model.id) ? 'composer.unfavorite' : 'composer.favorite')
                              | transloco
                          "
                          [attr.title]="
                            (isFavorite(model.id) ? 'composer.unfavorite' : 'composer.favorite')
                              | transloco
                          "
                          (click)="toggleFavorite(model.id)"
                        >
                          <svg
                            class="h-4 w-4"
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <path
                              d="m10 2.6 2.3 4.7 5.1.7-3.7 3.6.9 5.1L10 14.3l-4.6 2.4.9-5.1L2.6 8l5.1-.7z"
                            />
                          </svg>
                        </button>
                      </div>
                    } @empty {
                      <p class="px-4 py-5 text-center text-sm text-mist/40">
                        {{ 'composer.noModels' | transloco }}
                      </p>
                    }
                  </div>
                </div>
              }
            </div>

            <!-- Mode picker -->
            <div>
              <button
                type="button"
                class="flex h-7 items-center gap-1.5 rounded-full px-2 text-xs text-mist/60 transition-colors hover:bg-white/5 hover:text-white"
                [attr.aria-expanded]="modeOpen()"
                [attr.aria-controls]="modeOpen() ? 'composer-mode-menu' : null"
                (click)="modeOpen.set(!modeOpen())"
                (keydown.escape)="closeMenus()"
              >
                <span class="max-w-40 truncate">{{ selectedMode()?.name }}</span>
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

            <!-- Reasoning -->
            <div
              class="flex h-7 overflow-hidden rounded-full bg-white/5 p-0.5"
              role="group"
              [attr.aria-label]="'composer.reasoning' | transloco"
            >
              @for (option of reasoningOptions; track option) {
                <button
                  type="button"
                  class="rounded-full px-2 text-xs transition-colors disabled:opacity-30"
                  [class]="
                    option === reasoning()
                      ? 'bg-white/10 font-medium text-white'
                      : 'text-mist/50 hover:text-mist'
                  "
                  [attr.aria-pressed]="option === reasoning()"
                  [attr.aria-label]="'reasoning.' + option | transloco"
                  [attr.title]="'reasoning.' + option | transloco"
                  [disabled]="!supportsReasoning() && option !== 'off'"
                  (click)="selectReasoning(option)"
                >
                  {{ 'reasoning.' + option | transloco }}
                </button>
              }
            </div>

            <!-- Provider picker -->
            <div>
              <button
                type="button"
                class="flex h-7 items-center gap-1.5 rounded-full px-2 text-xs text-mist/60 transition-colors hover:bg-white/5 hover:text-white"
                [attr.aria-expanded]="providerOpen()"
                [attr.aria-controls]="providerOpen() ? 'composer-provider-menu' : null"
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
                    <span class="max-w-40 truncate">{{ key | transloco }}</span>
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
                    }
                    <span class="max-w-40 truncate">
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
                        @if (uptime(endpoint); as up) {
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
          </div>

          <div class="flex shrink-0 items-center gap-1.5">
            @if (streaming()) {
              <button
                type="button"
                class="flex h-8 min-w-28 items-center justify-center gap-1.5 rounded-full bg-rose-500/15 px-4 text-sm font-medium text-rose-300 transition-colors hover:bg-rose-500/25"
                (click)="stop()"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="6" width="8" height="8" rx="1.5" />
                </svg>
                {{ 'chat.stop' | transloco }}
              </button>
            } @else {
              <button
                type="button"
                class="flex h-8 min-w-28 items-center justify-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-ink transition-colors hover:bg-accent/90 disabled:opacity-40"
                [disabled]="!canSend()"
                (click)="send()"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path d="M4 16V4l12 6z" />
                </svg>
                {{ 'chat.send' | transloco }}
              </button>
            }
          </div>
        </div>
      </div>

      <div
        class="mx-auto mt-1.5 flex w-full max-w-4xl items-center gap-3 px-1 text-xs text-mist/40"
      >
        <p class="hidden min-w-0 flex-1 truncate sm:block">{{ 'chat.hint' | transloco }}</p>

        <div class="ml-auto flex shrink-0 items-center gap-3">
          @if (workspace.activeSession()) {
            <div class="group relative">
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-full bg-accent/15 px-3 py-1 text-xs font-medium text-accent ring-1 ring-accent/30 ring-inset transition-colors hover:bg-accent/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent/15 disabled:hover:text-accent"
                [disabled]="!canHandover()"
                [attr.aria-label]="'chat.handoverHint' | transloco"
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
                {{ 'chat.handoverHint' | transloco }}
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
                usage.limitLabel
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
  `,
})
export class Composer {
  protected readonly workspace = inject(WorkspaceService);
  protected readonly settings = inject(SettingsService);
  protected readonly modelsService = inject(ModelsService);

  protected readonly reasoningOptions = REASONING_OPTIONS;
  protected readonly providerPresets = PROVIDER_PRESETS;
  protected readonly circumference = CONTEXT_CIRCUMFERENCE;
  readonly composing = output<boolean>();
  protected readonly draft = signal('');
  protected readonly attachments = signal<MessageAttachment[]>([]);
  protected readonly mentions = signal<Mention[]>([]);
  protected readonly attachmentError = signal<string | null>(null);
  protected readonly dragging = signal(false);
  protected readonly modelOpen = signal(false);
  protected readonly providerOpen = signal(false);
  protected readonly modeOpen = signal(false);
  protected readonly modelFilter = signal('');
  protected readonly mentionOpen = signal(false);
  protected readonly mentionIndex = signal(0);
  protected readonly mentionKind = signal<MentionKind | null>(null);
  protected readonly mentionTerm = signal('');
  protected readonly mentionItems = signal<MentionItem[]>([]);

  private readonly workspaceEntries = signal<WorkspaceEntry[]>([]);
  private readonly skillNames = signal<string[]>([]);
  private readonly mcpServers = signal<string[]>([]);
  private mentionQuery: MentionQuery | null = null;
  private loadedEntriesFor = '';

  private readonly transloco = inject(TranslocoService);

  private readonly editorRef = viewChild<ElementRef<HTMLDivElement>>('editor');
  private readonly fileInputRef = viewChild<ElementRef<HTMLInputElement>>('fileInput');

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
    return session?.provider || 'auto';
  });
  protected readonly selectedModel = computed(() => this.modelsService.byId(this.model()));
  protected readonly modes = computed(() => this.settings.modes());
  protected readonly selectedMode = computed<Mode | undefined>(() => {
    const modes = this.settings.modes();
    const session = this.workspace.activeAgent();
    const id = session?.modeId ?? this.settings.settings()?.defaultModeId ?? 'coding';
    return (
      modes.find((mode) => mode.id === id) ?? modes.find((mode) => mode.id === 'coding') ?? modes[0]
    );
  });
  protected readonly favoriteModels = computed(
    () => this.settings.settings()?.favoriteModels ?? [],
  );
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
  protected readonly sessionCost = computed(() => this.workspace.activeAgent()?.cost ?? 0);
  protected readonly handover = computed(() => {
    const session = this.workspace.activeSession();
    return session ? this.workspace.isHandover(session.id) : false;
  });
  protected readonly canHandover = computed(() => {
    const session = this.workspace.activeSession();
    return (
      !!session &&
      !this.handover() &&
      this.settings.hasApiKey() &&
      !this.workspace.isStreaming(session.id) &&
      this.workspace.messagesFor(session.id).length > 0
    );
  });
  protected readonly contextUsage = computed(() => {
    const session = this.workspace.activeAgent();
    const limit = this.selectedModel()?.contextLength ?? 0;
    if (!session || limit <= 0) {
      return null;
    }
    const used = this.lastTurnTokens(session.id);
    if (used <= 0) {
      return null;
    }
    const ratio = Math.min(1, used / limit);
    return {
      ratio,
      percent: Math.max(1, Math.round(ratio * 100)),
      color: this.usageColor(ratio),
      usedLabel: used.toLocaleString(),
      limitLabel: limit.toLocaleString(),
    };
  });
  protected readonly filteredModels = computed(() => {
    const filter = this.modelFilter().trim().toLowerCase();
    const favorites = new Set(this.favoriteModels());
    const models = this.modelsService.models();
    const filtered = filter
      ? models.filter(
          (model) =>
            model.name.toLowerCase().includes(filter) || model.id.toLowerCase().includes(filter),
        )
      : models;
    const sorted = [...filtered].sort(
      (a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)),
    );
    return sorted.slice(0, 200);
  });
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
    effect(() => {
      const model = this.model();
      if (model) {
        untracked(() => void this.modelsService.loadEndpoints(model));
      }
    });
    effect(() => {
      const draft = this.workspace.pendingDraft();
      if (draft !== null) {
        this.setEditorText(draft);
        this.workspace.consumeDraft();
      }
    });
    effect(() => {
      this.draft();
      this.autoGrow();
    });
  }

  protected onEditorInput(): void {
    const { content, mentions } = this.serializeEditor();
    this.draft.set(content);
    this.mentions.set(mentions);
    this.composing.emit(content.trim().length > 0 || mentions.length > 0);
    this.autoGrow();
    this.updateMention();
  }

  protected onCaretMove(): void {
    if (this.mentionOpen()) {
      this.updateMention();
    }
  }

  private autoGrow(): void {
    const element = this.editorRef()?.nativeElement;
    if (!element) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }

  private focusInput(): void {
    this.editorRef()?.nativeElement.focus();
  }

  private setEditorText(text: string): void {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return;
    }
    editor.textContent = text;
    this.onEditorInput();
  }

  private serializeEditor(): { content: string; mentions: Mention[] } {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return { content: '', mentions: [] };
    }
    const mentions: Mention[] = [];
    let text = '';
    const walk = (node: Node): void => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.textContent ?? '';
          return;
        }
        if (!(child instanceof HTMLElement)) {
          return;
        }
        if (child.dataset['mention']) {
          const kind = child.dataset['kind'] as MentionKind;
          const value = child.dataset['value'] ?? '';
          const label = child.dataset['label'] ?? value;
          if (kind && !mentions.some((entry) => entry.kind === kind && entry.value === value)) {
            mentions.push({ kind, value, label });
          }
          text += ' ';
          return;
        }
        if (child.tagName === 'BR') {
          text += '\n';
          return;
        }
        walk(child);
        if (child.tagName === 'DIV' || child.tagName === 'P') {
          text += '\n';
        }
      });
    };
    walk(editor);
    const content = text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { content, mentions };
  }

  private detectQuery(): MentionQuery | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return null;
    }
    const node = selection.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      return null;
    }
    const text = node.textContent ?? '';
    const offset = selection.anchorOffset;
    const before = text.slice(0, offset);
    const match = /(?:^|\s)@([A-Za-z]*)(?::([^\s]*))?$/.exec(before);
    if (!match) {
      return null;
    }
    const token = match[0].replace(/^\s/, '');
    return {
      node: node as Text,
      start: offset - token.length,
      end: offset,
      kindPrefix: (match[1] ?? '').toLowerCase(),
      hasColon: match[2] !== undefined,
      term: match[2] ?? '',
    };
  }

  private createPill(mention: Mention): HTMLSpanElement {
    const pill = document.createElement('span');
    pill.className = 'mention-pill';
    pill.contentEditable = 'false';
    pill.dataset['mention'] = 'true';
    pill.dataset['kind'] = mention.kind;
    pill.dataset['value'] = mention.value;
    pill.dataset['label'] = mention.label;

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 20 20');
    icon.setAttribute('width', '12');
    icon.setAttribute('height', '12');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('class', 'mention-pill-icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', this.mentionIcon(mention.kind));
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    icon.appendChild(path);

    const kind = document.createElement('span');
    kind.className = 'mention-pill-kind';
    kind.textContent = mention.kind;

    const label = document.createElement('span');
    label.className = 'mention-pill-label';
    label.textContent = mention.label;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mention-pill-remove';
    remove.tabIndex = -1;
    remove.setAttribute('aria-label', this.transloco.translate('composer.removeMention'));
    remove.textContent = '\u00d7';
    remove.addEventListener('mousedown', (event) => event.preventDefault());
    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.removePill(pill);
    });

    pill.append(icon, kind, label, remove);
    return pill;
  }

  private insertPill(mention: Mention, query: MentionQuery | null): void {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return;
    }
    const selection = window.getSelection();

    if (query) {
      const text = query.node.textContent ?? '';
      const before = text.slice(0, query.start);
      const after = text.slice(query.end);
      const beforeNode = document.createTextNode(before);
      const afterNode = document.createTextNode(after);
      const parent = query.node.parentNode;
      if (!parent) {
        return;
      }
      parent.replaceChild(afterNode, query.node);
      parent.insertBefore(beforeNode, afterNode);
      const position = document.createRange();
      position.setStart(beforeNode, before.length);
      position.collapse(true);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(position);
      }
    }

    const position =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : document.createRange();
    const fragment = document.createDocumentFragment();
    const space = document.createTextNode(' ');
    fragment.append(this.createPill(mention), space);
    position.insertNode(fragment);

    const caret = document.createRange();
    caret.setStart(space, space.length);
    caret.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(caret);
    }

    editor.focus();
    this.onEditorInput();
  }

  private replaceQuery(text: string, query: MentionQuery): void {
    const value = query.node.textContent ?? '';
    const before = value.slice(0, query.start);
    const after = value.slice(query.end);
    query.node.textContent = before + text + after;
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      const caret = before.length + text.length;
      range.setStart(query.node, caret);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    this.focusInput();
    this.onEditorInput();
  }

  private removePill(pill: HTMLElement): void {
    const next = pill.nextSibling;
    pill.remove();
    if (next && next.nodeType === Node.TEXT_NODE && next.textContent === ' ') {
      next.remove();
    }
    this.onEditorInput();
    this.focusInput();
  }

  private insertLineBreak(): void {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) {
      return;
    }
    if (!document.execCommand('insertLineBreak')) {
      document.execCommand('insertHTML', false, '<br>');
    }
    this.onEditorInput();
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
      document.execCommand('insertText', false, text);
      this.onEditorInput();
    }
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
    const current = this.attachments();
    const accepted: MessageAttachment[] = [];
    let unsupported = false;
    let tooLarge = false;
    let tooMany = false;
    for (const file of selected) {
      if (current.length + accepted.length >= MAX_ATTACHMENTS) {
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
    if (accepted.length > 0) {
      this.attachments.set([...current, ...accepted]);
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

  protected onFilter(event: Event): void {
    this.modelFilter.set((event.target as HTMLInputElement).value);
  }

  protected closeMenus(): void {
    if (this.modelOpen() || this.providerOpen() || this.modeOpen()) {
      this.modelOpen.set(false);
      this.providerOpen.set(false);
      this.modeOpen.set(false);
      this.focusInput();
    }
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
      if (!project || this.loadedEntriesFor === project.id) {
        return;
      }
      this.loadedEntriesFor = project.id;
      try {
        this.workspaceEntries.set(await api.listWorkspaceEntries(project.id));
      } catch {
        this.workspaceEntries.set([]);
      }
      if (this.mentionKind() === kind) {
        this.mentionItems.set(this.filterMentionItems(kind, this.mentionTerm()));
      }
      return;
    }
    const settings = this.settings.settings();
    if (!settings) {
      return;
    }
    if (kind === 'skill') {
      if (this.skillNames().length === 0) {
        try {
          const candidates = await api.discoverSkills(
            settings.skillFolders,
            settings.skillsDisabled,
            settings.skillsAutoDiscovery,
          );
          const names = new Set<string>();
          for (const candidate of candidates) {
            for (const name of candidate.skills) {
              names.add(name);
            }
          }
          this.skillNames.set([...names].sort());
        } catch {
          this.skillNames.set([]);
        }
      }
    } else if (kind === 'mcp') {
      if (this.mcpServers().length === 0) {
        try {
          const candidates = await api.discoverMcpSources(
            settings.mcpFolders,
            settings.mcpDisabled,
            settings.mcpAutoDiscovery,
          );
          const names = new Set<string>();
          for (const candidate of candidates) {
            for (const name of candidate.servers) {
              names.add(name);
            }
          }
          this.mcpServers.set([...names].sort());
        } catch {
          this.mcpServers.set([]);
        }
      }
    }
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
        return this.skillNames()
          .filter((name) => needle === '' || name.toLowerCase().includes(needle))
          .slice(0, limit)
          .map((name) => ({ kind, value: name, label: name, sublabel: null }));
      case 'mcp':
        return this.mcpServers()
          .filter((name) => needle === '' || name.toLowerCase().includes(needle))
          .slice(0, limit)
          .map((name) => ({ kind, value: name, label: name, sublabel: null }));
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

  private stripMentions(text: string): string {
    return text
      .replace(MENTION_TOKEN_RE, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
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
    if (event.key === 'Escape' && (this.modelOpen() || this.providerOpen() || this.modeOpen())) {
      this.closeMenus();
      return;
    }
    if (event.key === 'Enter' && !this.modelOpen() && !this.providerOpen() && !this.modeOpen()) {
      event.preventDefault();
      if (event.shiftKey) {
        this.insertLineBreak();
      } else {
        void this.send();
      }
    }
  }

  protected async send(): Promise<void> {
    const session = this.workspace.activeAgent();
    const raw = this.draft().trim();
    const content = this.stripMentions(raw);
    const mentions = [...this.mentions()];
    for (const typed of this.parseMentions(raw)) {
      if (!mentions.some((entry) => entry.kind === typed.kind && entry.value === typed.value)) {
        mentions.push(typed);
      }
    }
    const model = this.model();
    const attachments = this.attachments();
    if (
      !session ||
      (!content && attachments.length === 0 && mentions.length === 0) ||
      !model ||
      this.streaming()
    ) {
      return;
    }
    this.setEditorText('');
    this.attachments.set([]);
    this.mentions.set([]);
    this.attachmentError.set(null);
    this.closeMention();
    await this.workspace.send({
      sessionId: session.id,
      content,
      model,
      reasoningEffort: this.reasoning(),
      provider: this.provider() === 'auto' ? null : this.provider(),
      attachments,
      mentions,
    });
    this.focusInput();
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

  protected async selectModel(modelId: string): Promise<void> {
    const session = this.workspace.activeAgent();
    this.modelOverride.set(session ? { sessionId: session.id, value: modelId } : null);
    this.providerOverride.set(session ? { sessionId: session.id, value: 'auto' } : null);
    this.modelOpen.set(false);
    this.focusInput();
    if (session) {
      await this.workspace.updateSession({ sessionId: session.id, model: modelId, provider: '' });
    }
  }

  protected isFavorite(modelId: string): boolean {
    return this.favoriteModels().includes(modelId);
  }

  protected async toggleFavorite(modelId: string): Promise<void> {
    const current = this.favoriteModels();
    const next = current.includes(modelId)
      ? current.filter((id) => id !== modelId)
      : [...current, modelId];
    await this.settings.patch({ favoriteModels: next });
  }

  protected async selectReasoning(option: string): Promise<void> {
    const session = this.workspace.activeAgent();
    this.reasoningOverride.set(session ? { sessionId: session.id, value: option } : null);
    if (session) {
      await this.workspace.updateSession({ sessionId: session.id, reasoningEffort: option });
    }
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
    const session = this.workspace.activeAgent();
    const slug = endpoint.slug.split('/')[0] || endpoint.providerName;
    this.providerOverride.set(session ? { sessionId: session.id, value: slug } : null);
    this.providerOpen.set(false);
    this.focusInput();
    if (session) {
      await this.workspace.updateSession({ sessionId: session.id, provider: slug });
    }
  }

  protected async selectAutoProvider(): Promise<void> {
    const session = this.workspace.activeAgent();
    this.providerOverride.set(session ? { sessionId: session.id, value: 'auto' } : null);
    this.providerOpen.set(false);
    this.focusInput();
    if (session) {
      await this.workspace.updateSession({ sessionId: session.id, provider: '' });
    }
  }

  protected async selectPreset(value: string): Promise<void> {
    const session = this.workspace.activeAgent();
    this.providerOverride.set(session ? { sessionId: session.id, value } : null);
    this.providerOpen.set(false);
    this.focusInput();
    if (session) {
      await this.workspace.updateSession({ sessionId: session.id, provider: value });
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
      return 'rgba(255,255,255,0.25)';
    }
    if (value >= 99) {
      return '#34d399';
    }
    if (value >= 95) {
      return '#fbbf24';
    }
    return '#fb7185';
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

  protected price(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  protected context(value: number): string {
    if (!value) {
      return '—';
    }
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    }
    return value >= 1000 ? `${Math.round(value / 1000)}k` : `${value}`;
  }

  protected money(value: number): string {
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  }

  private lastTurnTokens(sessionId: string): number {
    const messages = this.workspace.messagesFor(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'assistant' && message.promptTokens > 0) {
        return message.promptTokens + message.completionTokens;
      }
    }
    return 0;
  }

  private usageColor(ratio: number): string {
    if (ratio >= 0.9) {
      return '#fb7185';
    }
    if (ratio >= 0.75) {
      return '#fbbf24';
    }
    return 'var(--color-accent)';
  }
}
