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
import { EndpointInfo, MessageAttachment } from '../core/models';
import { ModelsService } from '../core/models.service';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';

const REASONING_OPTIONS = ['off', 'low', 'medium', 'high'];

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
  imports: [TranslocoPipe],
  template: `
    <div class="border-t border-white/10 bg-ink/40 px-4 pt-3 pb-3">
      <div
        class="relative mx-auto w-full max-w-4xl rounded-2xl border border-white/10 bg-navy/30 shadow-lg shadow-black/20 transition-colors focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/15"
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

        <textarea
          #input
          class="block max-h-[min(45vh,22rem)] min-h-[5.5rem] w-full resize-none overflow-y-auto bg-transparent px-4 pt-3.5 pr-3 pb-1 text-[15px] leading-relaxed text-white outline-none placeholder:text-mist/50"
          rows="1"
          enterkeyhint="send"
          [attr.aria-label]="'chat.placeholder' | transloco"
          [value]="draft()"
          [placeholder]="'chat.placeholder' | transloco"
          (input)="onInput($event)"
          (keydown)="onKeydown($event)"
          (paste)="onPaste($event)"
        ></textarea>

        <div class="flex items-end justify-between gap-2 border-t border-white/5 px-4 py-2">
          <div class="flex min-w-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-mist transition-colors hover:border-accent/40 hover:text-white"
              [attr.aria-label]="'composer.attach' | transloco"
              [attr.title]="'composer.attach' | transloco"
              (click)="openFilePicker()"
            >
              <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="M13.5 8.5 9 13a2.83 2.83 0 0 1-4-4l5-5a2.12 2.12 0 0 1 3 3l-5 5a.7.7 0 1 1-1-1l4.5-4.5"
                  stroke="currentColor"
                  stroke-width="1.4"
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
                class="flex h-8 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 text-sm text-mist transition-colors hover:border-accent/40 hover:text-white"
                [attr.aria-expanded]="modelOpen()"
                [attr.aria-controls]="modelOpen() ? 'composer-model-menu' : null"
                (click)="modelOpen.set(!modelOpen())"
                (keydown.escape)="closeMenus()"
              >
                <span class="max-w-56 truncate">{{
                  selectedModel()?.name ?? ('composer.noModels' | transloco)
                }}</span>
                <svg
                  class="h-3.5 w-3.5 shrink-0 text-mist/40"
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
                  class="absolute bottom-full left-0 z-40 mb-2 flex max-h-[min(24rem,50vh)] w-[min(30rem,100%)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-navy shadow-2xl"
                  id="composer-model-menu"
                  (keydown.escape)="closeMenus()"
                >
                  <input
                    class="border-b border-white/10 bg-transparent px-4 py-2.5 text-sm text-white outline-none placeholder:text-mist/50"
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

            <!-- Reasoning -->
            <div
              class="flex h-8 overflow-hidden rounded-full border border-white/10 bg-white/5 p-0.5"
              role="group"
              [attr.aria-label]="'composer.reasoning' | transloco"
            >
              @for (option of reasoningOptions; track option) {
                <button
                  type="button"
                  class="rounded-full px-2.5 text-sm transition-colors disabled:opacity-30"
                  [class]="
                    option === reasoning()
                      ? 'bg-accent font-medium text-ink'
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
                class="flex h-8 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 text-sm text-mist transition-colors hover:border-accent/40 hover:text-white"
                [attr.aria-expanded]="providerOpen()"
                [attr.aria-controls]="providerOpen() ? 'composer-provider-menu' : null"
                (click)="toggleProvider()"
                (keydown.escape)="closeMenus()"
              >
                <span class="flex min-w-0 items-center gap-1.5">
                  @if (presetKey(provider()); as key) {
                    <svg
                      class="h-3.5 w-3.5 shrink-0 text-accent"
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
                          class="h-3.5 w-3.5 shrink-0 rounded object-contain"
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
                  class="h-3.5 w-3.5 shrink-0 text-mist/40"
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
                  class="absolute bottom-full left-0 z-40 mb-2 max-h-[min(24rem,50vh)] w-[min(32rem,100%)] overflow-y-auto rounded-2xl border border-white/10 bg-navy shadow-2xl"
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
  protected readonly draft = signal('');
  protected readonly attachments = signal<MessageAttachment[]>([]);
  protected readonly attachmentError = signal<string | null>(null);
  protected readonly dragging = signal(false);
  protected readonly modelOpen = signal(false);
  protected readonly providerOpen = signal(false);
  protected readonly modelFilter = signal('');

  private readonly inputRef = viewChild<ElementRef<HTMLTextAreaElement>>('input');
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
      (this.draft().trim().length > 0 || this.attachments().length > 0) &&
      !!this.model() &&
      !this.streaming(),
  );
  protected readonly sessionCost = computed(() => this.workspace.activeAgent()?.cost ?? 0);
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
        this.draft.set(draft);
        this.workspace.consumeDraft();
      }
    });
    effect(() => {
      this.draft();
      this.autoGrow();
    });
  }

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
    this.autoGrow();
  }

  private autoGrow(): void {
    const element = this.inputRef()?.nativeElement;
    if (!element) {
      return;
    }
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }

  private focusInput(): void {
    this.inputRef()?.nativeElement.focus();
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
    if (this.modelOpen() || this.providerOpen()) {
      this.modelOpen.set(false);
      this.providerOpen.set(false);
      this.focusInput();
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === 'Escape' && (this.modelOpen() || this.providerOpen())) {
      this.closeMenus();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !this.modelOpen() && !this.providerOpen()) {
      event.preventDefault();
      void this.send();
    }
  }

  protected async send(): Promise<void> {
    const session = this.workspace.activeAgent();
    const content = this.draft().trim();
    const model = this.model();
    const attachments = this.attachments();
    if (!session || (!content && attachments.length === 0) || !model || this.streaming()) {
      return;
    }
    this.draft.set('');
    this.attachments.set([]);
    this.attachmentError.set(null);
    await this.workspace.send({
      sessionId: session.id,
      content,
      model,
      reasoningEffort: this.reasoning(),
      provider: this.provider() === 'auto' ? null : this.provider(),
      attachments,
    });
    this.focusInput();
  }

  protected async stop(): Promise<void> {
    const session = this.workspace.activeAgent();
    if (session) {
      await this.workspace.stop(session.id);
    }
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
