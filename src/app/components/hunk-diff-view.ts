import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  DiffRow,
  DiffSide,
  TextSegment,
  changeIds,
  colorizedLines,
  cursorStops,
  findRows,
  hunkChangeIds,
  hunkSides,
  isChange,
  markSegments,
  rangeIds,
  rowAt,
  rowLines,
  rowOfLine,
  rowOffsets,
  selectionPatch,
  selectionRange,
  selectionText,
  splitRows,
  unifiedRows,
  visualLength,
  wrappedLines,
} from '../core/diff-rows';
import { contextMenuStyle } from '../core/menu-position';
import { GitDiffHunk, GitDiffLine, GitHunkDiff, GitLineAction } from '../core/models';
import { MonacoService } from '../core/monaco.service';
import { ThemeService } from '../core/theme.service';

const ROW_HEIGHT = 20;
const HUNK_HEIGHT = 28;
/** Rows rendered beyond the viewport, in pixels, to smooth fast scrolling. */
const OVERSCAN_PX = 480;
const TAB_SIZE = 4;
/** Horizontal room of a line number cell besides its digits. */
const NUMBER_PADDING_PX = 16;
const SIGN_WIDTH_PX = 16;
const CODE_PADDING_PX = 24;
/** Diffs with more text than this are shown without syntax colors. */
const HIGHLIGHT_MAX_CHARS = 400_000;
/** Pointer distance from the top or bottom edge that scrolls while dragging. */
const EDGE_SCROLL_PX = 28;
const MENU_WIDTH_PX = 240;
const MENU_HEIGHT_PX = 180;

export interface LineActionRequest {
  action: GitLineAction;
  lines: number[];
}

/** A selection handed to the chat, with its file. */
export interface DiffQuestion {
  path: string;
  text: string;
}

/** A rendered row, flattened so the template needs no type narrowing. */
interface ViewItem {
  key: string;
  index: number;
  height: number;
  kind: DiffRow['type'];
  hunkIndex: number;
  hunk: GitDiffHunk;
  line: GitDiffLine | null;
  left: GitDiffLine | null;
  right: GitDiffLine | null;
}

interface Anchor {
  row: number;
  side: DiffSide;
}

/**
 * The Changes view's diff: hunks with line numbers in a unified or split
 * layout. Lines are picked like in Fork (click, drag, shift-click, cmd-click
 * or the keyboard) and staged, unstaged or discarded from a floating bar, a
 * context menu, the hunk headers or shortcuts. Rows are virtualized, so large
 * files and whole-file context stay responsive.
 */
@Component({
  selector: 'app-hunk-diff-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  host: { class: 'block h-full min-h-0' },
  template: `
    <div
      #root
      class="relative flex h-full min-h-0 flex-col focus:outline-none"
      tabindex="0"
      role="region"
      [attr.aria-label]="'git.diff.label' | transloco"
      (keydown)="onKeydown($event)"
    >
      @if (blockedKey(); as key) {
        <div
          class="flex shrink-0 items-center gap-2 border-b border-white/5 bg-white/[0.03] px-4 py-1.5 text-[11px] text-mist/50"
        >
          <span class="min-w-0 flex-1 truncate" [title]="key | transloco">{{
            key | transloco
          }}</span>
          @if (diff().blocked === 'whitespace') {
            <button
              type="button"
              class="shrink-0 rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-mist/70 transition-colors hover:bg-white/10 hover:text-accent"
              (click)="showWhitespace.emit()"
            >
              {{ 'git.diff.showWhitespace' | transloco }}
            </button>
          }
        </div>
      }

      @if (findOpen()) {
        <div class="flex shrink-0 items-center gap-1.5 border-b border-white/5 px-3 py-1">
          <input
            #findInput
            type="text"
            class="w-56 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-mist placeholder:text-mist/30 focus:border-accent/50 focus:outline-none"
            [placeholder]="'git.diff.find' | transloco"
            [value]="findQuery()"
            (input)="onFindInput($event)"
            (keydown)="onFindKeydown($event)"
          />
          <span class="min-w-16 text-[11px] text-mist/40">
            @if (findQuery()) {
              @if (findMatches().length > 0) {
                {{
                  'git.diff.findCount'
                    | transloco: { current: findIndex() + 1, total: findMatches().length }
                }}
              } @else {
                {{ 'git.diff.findNone' | transloco }}
              }
            }
          </span>
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center rounded-md text-mist/50 transition-colors hover:bg-white/10 hover:text-mist disabled:opacity-30"
            [disabled]="findMatches().length === 0"
            [title]="'git.diff.findPrevious' | transloco"
            (click)="nextMatch(-1)"
          >
            <svg
              viewBox="0 0 16 16"
              class="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M4 10 8 6l4 4" />
            </svg>
          </button>
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center rounded-md text-mist/50 transition-colors hover:bg-white/10 hover:text-mist disabled:opacity-30"
            [disabled]="findMatches().length === 0"
            [title]="'git.diff.findNext' | transloco"
            (click)="nextMatch(1)"
          >
            <svg
              viewBox="0 0 16 16"
              class="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          <button
            type="button"
            class="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-mist/40 transition-colors hover:bg-white/10 hover:text-rose-400"
            [attr.aria-label]="'common.close' | transloco"
            (click)="closeFind()"
          >
            <svg
              viewBox="0 0 16 16"
              class="h-3 w-3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      }

      @if (placeholder(); as key) {
        <div class="flex min-h-0 flex-1 items-center justify-center p-4">
          <p class="text-sm text-mist/40">{{ key | transloco }}</p>
        </div>
      } @else {
        <div
          #scroller
          class="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5"
          [class.overflow-x-hidden]="wrap()"
          (scroll)="onScroll()"
        >
          <div
            class="relative"
            [style.height.px]="layoutInfo().total"
            [style.width]="wrap() ? '100%' : contentWidth() + 'px'"
            [style.min-width.%]="100"
          >
            <div
              class="absolute inset-x-0 top-0"
              [style.transform]="'translateY(' + view().top + 'px)'"
            >
              @for (item of view().items; track item.key) {
                @if (item.kind === 'hunk') {
                  <div
                    class="flex cursor-default items-center border-y border-white/5 bg-white/[0.035]"
                    [style.height.px]="item.height"
                    (mousedown)="onHunkMouseDown($event, item.hunkIndex, item.index)"
                  >
                    <div
                      class="sticky left-0 flex min-w-0 items-center gap-2 px-3 font-sans text-[11px]"
                      [style.width.px]="viewportWidth()"
                    >
                      <span class="shrink-0 font-mono text-mist/35">{{
                        hunkLabel(item.hunk)
                      }}</span>
                      <span class="min-w-0 flex-1 truncate font-mono text-mist/50">{{
                        item.hunk.section
                      }}</span>
                      @if (!diff().blocked) {
                        @if (diff().staged) {
                          <button
                            type="button"
                            class="shrink-0 rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-mist/60 transition-colors hover:bg-white/10 hover:text-accent disabled:opacity-40"
                            [disabled]="busy()"
                            (click)="runHunk(item.hunkIndex, 'unstage')"
                          >
                            {{ 'git.diff.unstageHunk' | transloco }}
                          </button>
                        } @else {
                          <button
                            type="button"
                            class="shrink-0 rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-mist/60 transition-colors hover:bg-white/10 hover:text-accent disabled:opacity-40"
                            [disabled]="busy()"
                            (click)="runHunk(item.hunkIndex, 'stage')"
                          >
                            {{ 'git.diff.stageHunk' | transloco }}
                          </button>
                          <button
                            type="button"
                            class="shrink-0 rounded-md px-2 py-0.5 text-[11px] text-mist/40 transition-colors hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-40"
                            [disabled]="busy()"
                            (click)="runHunk(item.hunkIndex, 'discard')"
                          >
                            {{ 'git.diff.discardHunk' | transloco }}
                          </button>
                        }
                      }
                    </div>
                  </div>
                } @else if (item.kind === 'line' && item.line; as line) {
                  <div
                    class="diff-row flex"
                    [class]="rowClass(line, item.index)"
                    [style.height.px]="wrap() ? null : item.height"
                    [style.min-height.px]="rowHeight"
                    (mousedown)="onRowMouseDown($event, item.index, 'both')"
                    (contextmenu)="onRowContextMenu($event, item.index, 'both')"
                  >
                    <span class="diff-num" [style.width.px]="numberWidth()">{{
                      line.oldLine
                    }}</span>
                    <span class="diff-num" [style.width.px]="numberWidth()">{{
                      line.newLine
                    }}</span>
                    <span class="diff-sign" [class]="signClass(line)">{{ sign(line) }}</span>
                    <span class="diff-code" [class.diff-wrap]="wrap()">
                      @if (segments(line); as parts) {
                        @for (part of parts; track $index) {
                          @if (part.mark) {
                            <mark class="diff-mark">{{ part.text }}</mark>
                          } @else {
                            <ng-container>{{ part.text }}</ng-container>
                          }
                        }
                      } @else if (colored(line); as html) {
                        <span [innerHTML]="html"></span>
                      } @else {
                        <ng-container>{{ line.text }}</ng-container>
                      }
                      @if (line.noNewline) {
                        <span class="diff-eof" [title]="'git.diff.noNewline' | transloco">⏎</span>
                      }
                    </span>
                  </div>
                } @else {
                  <div
                    class="flex"
                    [style.height.px]="wrap() ? null : item.height"
                    [style.min-height.px]="rowHeight"
                  >
                    <div
                      class="diff-row flex min-w-0 flex-1 basis-0"
                      [class]="cellClass(item.left, item.index, 'left')"
                      (mousedown)="onRowMouseDown($event, item.index, 'left')"
                      (contextmenu)="onRowContextMenu($event, item.index, 'left')"
                    >
                      <span class="diff-num" [style.width.px]="numberWidth()">{{
                        item.left?.oldLine
                      }}</span>
                      <span class="diff-sign" [class]="signClass(item.left)">{{
                        sign(item.left)
                      }}</span>
                      @if (item.left; as line) {
                        <span class="diff-code" [class.diff-wrap]="wrap()">
                          @if (segments(line); as parts) {
                            @for (part of parts; track $index) {
                              @if (part.mark) {
                                <mark class="diff-mark">{{ part.text }}</mark>
                              } @else {
                                <ng-container>{{ part.text }}</ng-container>
                              }
                            }
                          } @else if (colored(line); as html) {
                            <span [innerHTML]="html"></span>
                          } @else {
                            <ng-container>{{ line.text }}</ng-container>
                          }
                          @if (line.noNewline && line.kind !== 'context') {
                            <span class="diff-eof" [title]="'git.diff.noNewline' | transloco"
                              >⏎</span
                            >
                          }
                        </span>
                      }
                    </div>
                    <div class="w-px shrink-0 bg-white/10"></div>
                    <div
                      class="diff-row flex min-w-0 flex-1 basis-0"
                      [class]="cellClass(item.right, item.index, 'right')"
                      (mousedown)="onRowMouseDown($event, item.index, 'right')"
                      (contextmenu)="onRowContextMenu($event, item.index, 'right')"
                    >
                      <span class="diff-num" [style.width.px]="numberWidth()">{{
                        item.right?.newLine
                      }}</span>
                      <span class="diff-sign" [class]="signClass(item.right)">{{
                        sign(item.right)
                      }}</span>
                      @if (item.right; as line) {
                        <span class="diff-code" [class.diff-wrap]="wrap()">
                          @if (segments(line); as parts) {
                            @for (part of parts; track $index) {
                              @if (part.mark) {
                                <mark class="diff-mark">{{ part.text }}</mark>
                              } @else {
                                <ng-container>{{ part.text }}</ng-container>
                              }
                            }
                          } @else if (colored(line); as html) {
                            <span [innerHTML]="html"></span>
                          } @else {
                            <ng-container>{{ line.text }}</ng-container>
                          }
                          @if (line.noNewline) {
                            <span class="diff-eof" [title]="'git.diff.noNewline' | transloco"
                              >⏎</span
                            >
                          }
                        </span>
                      }
                    </div>
                  </div>
                }
              }
            </div>
          </div>
          <span
            #measure
            class="diff-code pointer-events-none invisible absolute"
            aria-hidden="true"
            >{{ measureText }}</span
          >
        </div>
      }

      @if (selectionBar(); as bar) {
        <div
          class="glass-pop absolute right-5 z-20 flex items-center gap-1 rounded-lg p-1 text-xs shadow-xl"
          [style.top.px]="bar.top"
          (mousedown)="$event.preventDefault()"
        >
          <span class="px-1.5 text-[11px] text-mist/50">{{
            'git.diff.selectedLines' | transloco: { count: bar.count }
          }}</span>
          @if (canApply()) {
            @if (diff().staged) {
              <button
                type="button"
                class="rounded-md bg-accent/15 px-2.5 py-1 text-xs text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
                [disabled]="busy()"
                [title]="'git.diff.unstageHint' | transloco"
                (click)="run('unstage')"
              >
                {{ 'git.unstage' | transloco }}
              </button>
            } @else {
              <button
                type="button"
                class="rounded-md bg-accent/15 px-2.5 py-1 text-xs text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
                [disabled]="busy()"
                [title]="'git.diff.stageHint' | transloco"
                (click)="run('stage')"
              >
                {{ 'git.stage' | transloco }}
              </button>
              <button
                type="button"
                class="rounded-md px-2.5 py-1 text-xs text-mist/60 transition-colors hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-40"
                [disabled]="busy()"
                [title]="'git.diff.discardHint' | transloco"
                (click)="run('discard')"
              >
                {{ 'git.diff.discard' | transloco }}
              </button>
            }
          }
          <button
            type="button"
            class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-mist/60 transition-colors hover:bg-white/10 hover:text-mist"
            [title]="'git.diff.askPumr' | transloco"
            (click)="askPumr()"
          >
            <svg
              viewBox="0 0 16 16"
              class="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2H7l-3 2.5v-2.5h0.5a2 2 0 0 1-2-2z"
              />
            </svg>
            {{ 'git.diff.ask' | transloco }}
          </button>
        </div>
      }
    </div>

    @if (menu(); as position) {
      <div
        class="fixed inset-0 z-40"
        (mousedown)="closeMenu()"
        (contextmenu)="onMenuBackdrop($event)"
      ></div>
      <div
        class="glass-pop fixed z-50 w-60 overflow-hidden rounded-xl py-1 text-[13px] text-mist shadow-2xl"
        [style]="position"
      >
        @if (canApply()) {
          @if (diff().staged) {
            <button
              type="button"
              class="menu-item"
              [disabled]="busy()"
              (click)="menuRun('unstage')"
            >
              {{ 'git.diff.unstageLines' | transloco: { count: selected().size } }}
            </button>
          } @else {
            <button type="button" class="menu-item" [disabled]="busy()" (click)="menuRun('stage')">
              {{ 'git.diff.stageLines' | transloco: { count: selected().size } }}
            </button>
            <button
              type="button"
              class="menu-item text-rose-400"
              [disabled]="busy()"
              (click)="menuRun('discard')"
            >
              {{ 'git.diff.discardLines' | transloco: { count: selected().size } }}
            </button>
          }
          <div class="menu-sep"></div>
        }
        <button type="button" class="menu-item" (click)="menuCopy()">
          {{ 'git.diff.copyLines' | transloco }}
        </button>
        <button type="button" class="menu-item" (click)="menuAsk()">
          {{ 'git.diff.askPumr' | transloco }}
        </button>
      </div>
    }
  `,
  styles: `
    .diff-row {
      cursor: default;
      user-select: none;
    }
    .diff-num {
      flex-shrink: 0;
      padding-right: 8px;
      text-align: right;
      color: rgb(from var(--color-mist) r g b / 0.28);
      font-variant-numeric: tabular-nums;
    }
    .diff-sign {
      flex-shrink: 0;
      width: ${SIGN_WIDTH_PX}px;
      text-align: center;
      color: rgb(from var(--color-mist) r g b / 0.3);
    }
    .diff-code {
      flex: 1 1 auto;
      min-width: 0;
      padding-right: ${CODE_PADDING_PX}px;
      white-space: pre;
      tab-size: ${TAB_SIZE};
      color: rgb(from var(--color-mist) r g b / 0.85);
    }
    .diff-code.diff-wrap {
      white-space: pre-wrap;
      word-break: break-all;
    }
    .diff-eof {
      margin-left: 4px;
      color: rgb(244 63 94 / 0.6);
    }
    .diff-mark {
      border-radius: 2px;
      background: rgb(from var(--color-accent) r g b / 0.35);
      color: inherit;
    }
    .menu-item {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 0.75rem;
      text-align: left;
      transition: background-color 120ms ease;
    }
    .menu-item:hover:not(:disabled) {
      background: rgb(255 255 255 / 0.08);
      color: #fff;
    }
    .menu-item:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .menu-sep {
      margin: 0.25rem 0.5rem;
      border-top: 1px solid rgb(255 255 255 / 0.08);
    }
  `,
})
export class HunkDiffView {
  readonly diff = input.required<GitHunkDiff>();
  readonly layout = input<'unified' | 'split'>('unified');
  readonly wrap = input(false);
  readonly busy = input(false);
  readonly lineAction = output<LineActionRequest>();
  readonly ask = output<DiffQuestion>();
  readonly showWhitespace = output<void>();

  private readonly monaco = inject(MonacoService);
  private readonly theme = inject(ThemeService);
  private readonly transloco = inject(TranslocoService);
  private readonly root = viewChild<ElementRef<HTMLDivElement>>('root');
  private readonly scroller = viewChild<ElementRef<HTMLDivElement>>('scroller');
  private readonly measure = viewChild<ElementRef<HTMLSpanElement>>('measure');
  private readonly findInput = viewChild<ElementRef<HTMLInputElement>>('findInput');

  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly measureText = 'x'.repeat(64);
  protected readonly selected = signal<ReadonlySet<number>>(new Set());
  protected readonly scrollTop = signal(0);
  protected readonly viewportHeight = signal(0);
  protected readonly viewportWidth = signal(0);
  protected readonly charWidth = signal(7.2);
  protected readonly findOpen = signal(false);
  protected readonly findQuery = signal('');
  protected readonly findIndex = signal(0);
  protected readonly menu = signal<Record<string, string> | null>(null);
  private readonly highlight = signal<{ diff: GitHunkDiff; lines: Map<number, string> } | null>(
    null,
  );

  /** Where a pointer range starts; the keyboard cursor moves from `cursorId`. */
  private anchor: Anchor | null = null;
  private cursorId: number | null = null;
  /** The line a shift-extended keyboard selection grows from. */
  private keyboardAnchor: number | null = null;
  private charMeasured = false;
  /** Lines kept when a cmd-drag adds a range to an earlier selection. */
  private base: ReadonlySet<number> = new Set();
  private dragging = false;
  private dragPointerY = 0;
  private edgeTimer: ReturnType<typeof setInterval> | null = null;
  private highlightToken = 0;
  private shownPath: string | null = null;
  private resizeObserver: ResizeObserver | null = null;

  protected readonly rows = computed(() =>
    this.layout() === 'split' ? splitRows(this.diff()) : unifiedRows(this.diff()),
  );

  private readonly stops = computed(() => cursorStops(this.rows()));

  /** Widest line number, which sizes the number columns. */
  protected readonly numberWidth = computed(() => {
    let widest = 1;
    for (const hunk of this.diff().hunks) {
      widest = Math.max(widest, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines);
    }
    return String(widest).length * this.charWidth() + NUMBER_PADDING_PX;
  });

  private readonly gutterWidth = computed(
    () =>
      (this.layout() === 'split' ? 1 : 2) * this.numberWidth() + SIGN_WIDTH_PX + CODE_PADDING_PX,
  );

  /** Width of the unwrapped content, so the horizontal scrollbar stays put while scrolling. */
  protected readonly contentWidth = computed(() => {
    let longest = 0;
    for (const hunk of this.diff().hunks) {
      for (const line of hunk.lines) {
        longest = Math.max(longest, visualLength(line.text, TAB_SIZE));
      }
    }
    const side = this.gutterWidth() + longest * this.charWidth() + 16;
    return this.layout() === 'split'
      ? Math.max(this.viewportWidth(), 2 * side + 1)
      : Math.max(this.viewportWidth(), side);
  });

  protected readonly layoutInfo = computed(() => {
    const rows = this.rows();
    const wrap = this.wrap();
    const split = this.layout() === 'split';
    const textWidth =
      (split ? (this.viewportWidth() - 1) / 2 : this.viewportWidth()) - this.gutterWidth();
    const columns = Math.floor(textWidth / this.charWidth());
    const heights = rows.map((row) => {
      if (row.type === 'hunk') {
        return HUNK_HEIGHT;
      }
      if (!wrap) {
        return ROW_HEIGHT;
      }
      const lines = rowLines(row, 'both');
      return (
        ROW_HEIGHT * Math.max(1, ...lines.map((line) => wrappedLines(line.text, columns, TAB_SIZE)))
      );
    });
    return { heights, ...rowOffsets(heights) };
  });

  protected readonly view = computed(() => {
    const rows = this.rows();
    const { heights, offsets } = this.layoutInfo();
    if (rows.length === 0) {
      return { items: [] as ViewItem[], top: 0 };
    }
    const top = this.scrollTop();
    const start = rowAt(offsets, Math.max(0, top - OVERSCAN_PX));
    const end = rowAt(offsets, top + Math.max(this.viewportHeight(), 400) + OVERSCAN_PX);
    const hunks = this.diff().hunks;
    const items: ViewItem[] = [];
    for (let index = start; index <= end; index += 1) {
      const row = rows[index];
      items.push({
        key: row.key,
        index,
        height: heights[index],
        kind: row.type,
        hunkIndex: row.hunk,
        hunk: hunks[row.hunk],
        line: row.type === 'line' ? row.line : null,
        left: row.type === 'pair' ? row.left : null,
        right: row.type === 'pair' ? row.right : null,
      });
    }
    return { items, top: offsets[start] };
  });

  protected readonly placeholder = computed(() => {
    const diff = this.diff();
    if (diff.binary) {
      return 'common.binaryFile';
    }
    if (diff.tooLarge) {
      return 'common.fileTooLarge';
    }
    return diff.hunks.length === 0 ? 'git.diff.noLineChanges' : null;
  });

  protected readonly blockedKey = computed(() => {
    const blocked = this.diff().blocked;
    return blocked === 'whitespace' || blocked === 'symlink' || blocked === 'submodule'
      ? `git.diff.blocked.${blocked}`
      : null;
  });

  protected readonly canApply = computed(() => !this.diff().blocked);

  protected readonly findMatches = computed(() => findRows(this.rows(), this.findQuery()));

  /** The floating bar, next to the first chosen line but always in view. */
  protected readonly selectionBar = computed(() => {
    const selected = this.selected();
    if (selected.size === 0 || this.menu()) {
      return null;
    }
    const rows = this.rows();
    const first = rows.findIndex((row) =>
      rowLines(row, 'both').some((line) => selected.has(line.id)),
    );
    if (first < 0) {
      return null;
    }
    // The banner and find bar above the rows move the scroller down.
    this.findOpen();
    this.blockedKey();
    const scroller = this.scroller()?.nativeElement;
    const offset = scroller?.offsetTop ?? 0;
    const rowTop = this.layoutInfo().offsets[first] - this.scrollTop();
    const top = Math.min(Math.max(rowTop - 34, 4), Math.max(4, this.viewportHeight() - 36));
    return { top: offset + top, count: selected.size };
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    // A new diff (another file, or the same file after lines moved) starts
    // without a selection; another file also starts at the top.
    effect(() => {
      const diff = this.diff();
      untracked(() => {
        this.selected.set(new Set());
        this.anchor = null;
        this.cursorId = null;
        this.base = new Set();
        this.menu.set(null);
        const key = `${diff.staged ? 's' : 'u'}:${diff.path}`;
        if (key !== this.shownPath) {
          this.shownPath = key;
          const scroller = this.scroller()?.nativeElement;
          if (scroller) {
            scroller.scrollTop = 0;
            scroller.scrollLeft = 0;
          }
          this.scrollTop.set(0);
        }
      });
    });
    effect(() => {
      const diff = this.diff();
      this.theme.current();
      untracked(() => void this.colorize(diff));
    });
    // The scroller is recreated when a placeholder was shown in between.
    effect(() => {
      const scroller = this.scroller()?.nativeElement;
      this.resizeObserver?.disconnect();
      if (!scroller) {
        return;
      }
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.measureViewport());
        this.resizeObserver.observe(scroller);
      }
      untracked(() => this.measureViewport());
    });
    effect(() => {
      const element = this.findInput()?.nativeElement;
      if (element) {
        element.focus();
        element.select();
      }
    });
    afterNextRender(() => this.measureCharWidth());
    destroyRef.onDestroy(() => {
      this.resizeObserver?.disconnect();
      this.stopDrag();
    });
  }

  /** Opens the find bar, or focuses it when it is open. */
  openFind(): void {
    if (this.findOpen()) {
      this.findInput()?.nativeElement.focus();
      this.findInput()?.nativeElement.select();
    }
    this.findOpen.set(true);
  }

  protected hunkLabel(hunk: GitDiffHunk): string {
    return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  }

  protected sign(line: GitDiffLine | null): string {
    return line?.kind === 'add' ? '+' : line?.kind === 'del' ? '-' : '';
  }

  protected signClass(line: GitDiffLine | null): string {
    return line?.kind === 'add' ? 'text-emerald-400' : line?.kind === 'del' ? 'text-rose-400' : '';
  }

  protected rowClass(line: GitDiffLine, index: number): string {
    return this.cellClass(line, index, 'both');
  }

  protected cellClass(line: GitDiffLine | null, index: number, side: DiffSide): string {
    const classes: string[] = [];
    if (line && this.selected().has(line.id) && (side === 'both' || isChange(line))) {
      classes.push('bg-accent/25 shadow-[inset_2px_0_0_var(--color-accent)]');
    } else if (line?.kind === 'add') {
      classes.push('bg-emerald-500/[0.09]');
    } else if (line?.kind === 'del') {
      classes.push('bg-rose-500/[0.09]');
    } else if (!line) {
      classes.push('bg-white/[0.02]');
    }
    if (this.findQuery() && this.findMatches()[this.findIndex()] === index) {
      classes.push('outline outline-1 -outline-offset-1 outline-amber-400/60');
    }
    return classes.join(' ');
  }

  protected segments(line: GitDiffLine): TextSegment[] | null {
    const query = this.findQuery();
    return query && line.text.toLowerCase().includes(query.toLowerCase())
      ? markSegments(line.text, query)
      : null;
  }

  protected colored(line: GitDiffLine): string | null {
    const highlight = this.highlight();
    return highlight && highlight.diff === this.diff()
      ? (highlight.lines.get(line.id) ?? null)
      : null;
  }

  protected onScroll(): void {
    const scroller = this.scroller()?.nativeElement;
    if (scroller) {
      this.scrollTop.set(scroller.scrollTop);
    }
    if (this.menu()) {
      this.menu.set(null);
    }
  }

  // Pointer selection

  protected onRowMouseDown(event: MouseEvent, row: number, side: DiffSide): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.focusRoot();
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey && this.anchor) {
      this.selectRange(row);
      this.startDrag(event);
      return;
    }
    const ids = this.idsAt(row, side);
    this.keyboardAnchor = ids[0] ?? null;
    if (additive && ids.length > 0 && ids.every((id) => this.selected().has(id))) {
      const next = new Set(this.selected());
      ids.forEach((id) => next.delete(id));
      this.selected.set(next);
      this.anchor = { row, side };
      this.base = next;
      return;
    }
    this.base = additive ? new Set(this.selected()) : new Set();
    this.anchor = { row, side };
    this.selectRange(row);
    this.startDrag(event);
  }

  /** A hunk header picks all of its changes. */
  protected onHunkMouseDown(event: MouseEvent, hunk: number, row: number): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) {
      return;
    }
    event.preventDefault();
    this.focusRoot();
    this.selectHunk(hunk, row);
  }

  protected onRowContextMenu(event: MouseEvent, row: number, side: DiffSide): void {
    event.preventDefault();
    this.focusRoot();
    const ids = this.idsAt(row, side);
    if (ids.length > 0 && !ids.some((id) => this.selected().has(id))) {
      this.base = new Set();
      this.anchor = { row, side };
      this.selected.set(new Set(ids));
      this.cursorId = ids[0];
    }
    if (this.selected().size === 0) {
      return;
    }
    this.menu.set(contextMenuStyle(event.clientX, event.clientY, MENU_WIDTH_PX, MENU_HEIGHT_PX));
  }

  private idsAt(row: number, side: DiffSide): number[] {
    const target = this.rows()[row];
    return target
      ? rowLines(target, side)
          .filter(isChange)
          .map((line) => line.id)
      : [];
  }

  private selectRange(to: number): void {
    const anchor = this.anchor;
    if (!anchor) {
      return;
    }
    const ids = rangeIds(this.rows(), anchor.row, to, anchor.side);
    this.selected.set(new Set([...this.base, ...ids]));
    if (ids.length > 0) {
      this.cursorId = to >= anchor.row ? ids[ids.length - 1] : ids[0];
    }
  }

  private startDrag(event: MouseEvent): void {
    this.dragging = true;
    this.dragPointerY = event.clientY;
    document.addEventListener('mousemove', this.onDragMove);
    document.addEventListener('mouseup', this.onDragEnd);
  }

  private readonly onDragMove = (event: MouseEvent): void => {
    if (!this.dragging) {
      return;
    }
    this.dragPointerY = event.clientY;
    this.dragTo(event.clientY);
    const scroller = this.scroller()?.nativeElement;
    if (!scroller) {
      return;
    }
    const rect = scroller.getBoundingClientRect();
    const nearEdge =
      event.clientY < rect.top + EDGE_SCROLL_PX || event.clientY > rect.bottom - EDGE_SCROLL_PX;
    if (nearEdge && !this.edgeTimer) {
      this.edgeTimer = setInterval(() => this.scrollAtEdge(), 30);
    } else if (!nearEdge && this.edgeTimer) {
      clearInterval(this.edgeTimer);
      this.edgeTimer = null;
    }
  };

  private readonly onDragEnd = (): void => this.stopDrag();

  private stopDrag(): void {
    this.dragging = false;
    document.removeEventListener('mousemove', this.onDragMove);
    document.removeEventListener('mouseup', this.onDragEnd);
    if (this.edgeTimer) {
      clearInterval(this.edgeTimer);
      this.edgeTimer = null;
    }
  }

  private dragTo(clientY: number): void {
    const scroller = this.scroller()?.nativeElement;
    if (!scroller) {
      return;
    }
    const y = clientY - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const row = rowAt(this.layoutInfo().offsets, y);
    if (row >= 0) {
      this.selectRange(row);
    }
  }

  private scrollAtEdge(): void {
    const scroller = this.scroller()?.nativeElement;
    if (!scroller || !this.dragging) {
      return;
    }
    const rect = scroller.getBoundingClientRect();
    const up = rect.top + EDGE_SCROLL_PX - this.dragPointerY;
    const down = this.dragPointerY - (rect.bottom - EDGE_SCROLL_PX);
    const step = up > 0 ? -Math.min(40, 4 + up) : down > 0 ? Math.min(40, 4 + down) : 0;
    if (step !== 0) {
      scroller.scrollTop += step;
      this.scrollTop.set(scroller.scrollTop);
      this.dragTo(this.dragPointerY);
    }
  }

  // Keyboard

  protected onKeydown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement) {
      return;
    }
    const modifier = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (modifier && !event.altKey) {
      if (key === 'f') {
        event.preventDefault();
        this.openFind();
      } else if (key === 'a') {
        event.preventDefault();
        this.base = new Set();
        this.selected.set(new Set(changeIds(this.diff())));
      } else if (key === 'c' && this.selected().size > 0) {
        event.preventDefault();
        void this.copySelection();
      }
      return;
    }
    if (event.altKey) {
      return;
    }
    switch (event.key) {
      case 'Escape':
        if (this.menu()) {
          this.closeMenu();
        } else if (this.findOpen()) {
          this.closeFind();
        } else {
          this.selected.set(new Set());
        }
        break;
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        this.moveCursor(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
        break;
      case 'j':
      case 'k':
        event.preventDefault();
        this.jumpHunk(event.key === 'j' ? 1 : -1);
        break;
      case 's':
        if (!this.diff().staged) {
          event.preventDefault();
          this.run('stage');
        }
        break;
      case 'u':
        if (this.diff().staged) {
          event.preventDefault();
          this.run('unstage');
        }
        break;
      case 'Backspace':
      case 'Delete':
        if (!this.diff().staged) {
          event.preventDefault();
          this.run('discard');
        }
        break;
    }
  }

  private moveCursor(direction: number, extend: boolean): void {
    const stops = this.stops();
    if (stops.length === 0) {
      return;
    }
    const current = stops.findIndex((stop) => stop.id === this.cursorId);
    let next: number;
    if (current < 0) {
      const firstVisible = rowAt(this.layoutInfo().offsets, this.scrollTop());
      const ahead = stops.findIndex((stop) => stop.row >= firstVisible);
      next = direction > 0 ? (ahead >= 0 ? ahead : stops.length - 1) : ahead > 0 ? ahead - 1 : 0;
    } else {
      next = Math.min(stops.length - 1, Math.max(0, current + direction));
    }
    const stop = stops[next];
    if (extend) {
      let from = stops.findIndex((entry) => entry.id === this.keyboardAnchor);
      if (from < 0) {
        from = current >= 0 ? current : next;
        this.keyboardAnchor = stops[from].id;
      }
      const [low, high] = from <= next ? [from, next] : [next, from];
      const ids = stops.slice(low, high + 1).map((entry) => entry.id);
      this.selected.set(new Set([...this.base, ...ids]));
      this.anchor = { row: stops[from].row, side: stops[from].side };
    } else {
      this.base = new Set();
      this.keyboardAnchor = stop.id;
      this.anchor = { row: stop.row, side: stop.side };
      this.selected.set(new Set([stop.id]));
    }
    this.cursorId = stop.id;
    this.revealRow(stop.row);
  }

  /** Moves to the next or previous hunk and picks its changes. */
  private jumpHunk(direction: number): void {
    const rows = this.rows();
    const count = this.diff().hunks.length;
    if (count === 0) {
      return;
    }
    const cursorRow = this.cursorId !== null ? rowOfLine(rows, this.cursorId) : -1;
    let target: number;
    if (cursorRow >= 0 && this.selected().size > 0) {
      target = rows[cursorRow].hunk + direction;
    } else {
      // Without a selection the first visible hunk is next.
      const visible = rows[rowAt(this.layoutInfo().offsets, this.scrollTop())]?.hunk ?? 0;
      target = direction > 0 ? visible : visible - 1;
    }
    target = Math.min(count - 1, Math.max(0, target));
    const header = rows.findIndex((row) => row.type === 'hunk' && row.hunk === target);
    this.selectHunk(target, header);
    this.revealRow(header, true);
  }

  private selectHunk(hunk: number, row: number): void {
    const ids = hunkChangeIds(this.diff().hunks[hunk]);
    this.base = new Set();
    this.anchor = { row, side: 'both' };
    this.keyboardAnchor = ids[0] ?? null;
    this.cursorId = ids[ids.length - 1] ?? null;
    this.selected.set(new Set(ids));
  }

  private revealRow(row: number, toTop = false): void {
    const scroller = this.scroller()?.nativeElement;
    if (!scroller || row < 0) {
      return;
    }
    const { offsets, heights } = this.layoutInfo();
    const top = offsets[row];
    const bottom = top + heights[row];
    if (toTop) {
      scroller.scrollTop = Math.max(0, top - 4);
    } else if (top < scroller.scrollTop) {
      scroller.scrollTop = top - ROW_HEIGHT;
    } else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight + ROW_HEIGHT;
    }
    this.scrollTop.set(scroller.scrollTop);
  }

  // Actions

  protected run(action: GitLineAction): void {
    const lines = [...this.selected()];
    if (lines.length === 0 || !this.canApply() || this.busy()) {
      return;
    }
    this.lineAction.emit({ action, lines });
  }

  protected runHunk(hunk: number, action: GitLineAction): void {
    if (this.busy()) {
      return;
    }
    this.lineAction.emit({ action, lines: hunkChangeIds(this.diff().hunks[hunk]) });
  }

  protected askPumr(): void {
    const diff = this.diff();
    const selected = this.selected();
    const range = selectionRange(diff, selected);
    if (!range) {
      return;
    }
    const header = this.transloco.translate(
      diff.staged ? 'git.diff.askStaged' : 'git.diff.askUnstaged',
      {
        path: diff.path,
        from: range.from,
        to: range.to,
      },
    );
    const text = `${header}\n\`\`\`diff\n${selectionPatch(diff, selected)}\n\`\`\``;
    this.ask.emit({ path: diff.path, text });
  }

  private async copySelection(): Promise<void> {
    try {
      await navigator.clipboard.writeText(selectionText(this.diff(), this.selected()));
    } catch {
      // The clipboard may be unavailable.
    }
  }

  protected closeMenu(): void {
    this.menu.set(null);
  }

  protected onMenuBackdrop(event: MouseEvent): void {
    event.preventDefault();
    this.closeMenu();
  }

  protected menuRun(action: GitLineAction): void {
    this.closeMenu();
    this.run(action);
  }

  protected menuCopy(): void {
    this.closeMenu();
    void this.copySelection();
  }

  protected menuAsk(): void {
    this.closeMenu();
    this.askPumr();
  }

  // Find

  protected onFindInput(event: Event): void {
    this.findQuery.set((event.target as HTMLInputElement).value);
    this.findIndex.set(0);
    this.revealMatch();
  }

  protected onFindKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.nextMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.closeFind();
    }
  }

  protected nextMatch(direction: number): void {
    const total = this.findMatches().length;
    if (total === 0) {
      return;
    }
    this.findIndex.update((index) => (index + direction + total) % total);
    this.revealMatch();
  }

  protected closeFind(): void {
    this.findOpen.set(false);
    this.findQuery.set('');
    this.findIndex.set(0);
    this.focusRoot();
  }

  private revealMatch(): void {
    const row = this.findMatches()[this.findIndex()];
    const scroller = this.scroller()?.nativeElement;
    if (row === undefined || !scroller) {
      return;
    }
    const { offsets } = this.layoutInfo();
    const top = offsets[row];
    if (top < scroller.scrollTop || top > scroller.scrollTop + scroller.clientHeight - ROW_HEIGHT) {
      scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 2);
      this.scrollTop.set(scroller.scrollTop);
    }
  }

  // Measuring and colors

  private focusRoot(): void {
    this.root()?.nativeElement.focus({ preventScroll: true });
  }

  private measureViewport(): void {
    const scroller = this.scroller()?.nativeElement;
    if (!scroller) {
      return;
    }
    if (!this.charMeasured) {
      this.measureCharWidth();
    }
    this.viewportHeight.set(scroller.clientHeight);
    this.viewportWidth.set(scroller.clientWidth);
    this.scrollTop.set(scroller.scrollTop);
  }

  private measureCharWidth(): void {
    const element = this.measure()?.nativeElement;
    const width = element ? element.getBoundingClientRect().width / this.measureText.length : 0;
    if (width > 0) {
      this.charWidth.set(width);
      this.charMeasured = true;
    }
  }

  /** Colors each hunk side on its own, so a construct cut at a hunk edge cannot leak. */
  private async colorize(diff: GitHunkDiff): Promise<void> {
    const token = ++this.highlightToken;
    const size = diff.hunks.reduce(
      (total, hunk) => total + hunk.lines.reduce((sum, line) => sum + line.text.length + 1, 0),
      0,
    );
    if (diff.language === 'plaintext' || size === 0 || size > HIGHLIGHT_MAX_CHARS) {
      this.highlight.set(null);
      return;
    }
    const lines = new Map<number, string>();
    try {
      for (const hunk of diff.hunks) {
        const sides = hunkSides(hunk);
        for (const side of [sides.old, sides.new]) {
          if (side.ids.length === 0) {
            continue;
          }
          const html = await this.monaco.colorize(side.text, diff.language, TAB_SIZE);
          if (token !== this.highlightToken) {
            return;
          }
          const split = colorizedLines(html, side.ids.length);
          split?.forEach((entry, index) => lines.set(side.ids[index], entry));
        }
      }
    } catch {
      return;
    }
    if (token === this.highlightToken) {
      this.highlight.set({ diff, lines });
    }
  }
}
