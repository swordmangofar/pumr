import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MessageAttachment } from '../core/models';

type Tool = 'pen' | 'highlighter' | 'arrow' | 'rectangle' | 'ellipse' | 'text' | 'crop';

interface Point {
  x: number;
  y: number;
}

interface Shape {
  tool: Exclude<Tool, 'crop'>;
  color: string;
  width: number;
  points: Point[];
  text?: string;
  background?: string;
}

interface EditorState {
  base: HTMLCanvasElement;
  shapes: Shape[];
}

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PRESET_COLORS = [
  '#ef4444',
  '#f97316',
  '#facc15',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
  '#ffffff',
  '#0f172a',
];

const TEXT_SIZES = [14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72];

const MIN_SHAPE_SIZE = 4;

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16) || 0;
  const g = Number.parseInt(value.slice(2, 4), 16) || 0;
  const b = Number.parseInt(value.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawArrow(
  context: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  width: number,
): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = Math.max(width * 3.5, 10);
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x - Math.cos(angle) * head * 0.7, to.y - Math.sin(angle) * head * 0.7);
  context.stroke();
  context.beginPath();
  context.moveTo(to.x, to.y);
  context.lineTo(
    to.x - head * Math.cos(angle - Math.PI / 7),
    to.y - head * Math.sin(angle - Math.PI / 7),
  );
  context.lineTo(
    to.x - head * Math.cos(angle + Math.PI / 7),
    to.y - head * Math.sin(angle + Math.PI / 7),
  );
  context.closePath();
  context.fill();
}

function drawShape(context: CanvasRenderingContext2D, shape: Shape): void {
  const start = shape.points[0];
  if (!start) {
    return;
  }
  if (shape.tool !== 'text' && shape.points.length < 2) {
    return;
  }
  const end = shape.points[shape.points.length - 1];
  context.save();
  context.strokeStyle = shape.color;
  context.fillStyle = shape.color;
  context.lineWidth = shape.width;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  if (shape.tool === 'highlighter') {
    context.globalAlpha = 0.35;
  }
  switch (shape.tool) {
    case 'pen':
    case 'highlighter': {
      context.beginPath();
      shape.points.forEach((point, index) => {
        if (index === 0) {
          context.moveTo(point.x, point.y);
        } else {
          context.lineTo(point.x, point.y);
        }
      });
      context.stroke();
      break;
    }
    case 'rectangle':
      context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      break;
    case 'ellipse': {
      const centerX = (start.x + end.x) / 2;
      const centerY = (start.y + end.y) / 2;
      context.beginPath();
      context.ellipse(
        centerX,
        centerY,
        Math.abs(end.x - start.x) / 2,
        Math.abs(end.y - start.y) / 2,
        0,
        0,
        Math.PI * 2,
      );
      context.stroke();
      break;
    }
    case 'arrow':
      drawArrow(context, start, end, shape.width);
      break;
    case 'text': {
      const size = shape.width;
      context.font = `600 ${size}px system-ui, -apple-system, sans-serif`;
      context.textBaseline = 'top';
      const lines = (shape.text ?? '').split('\n');
      const lineHeight = size * 1.25;
      if (shape.background) {
        const padding = size * 0.35;
        const width = Math.max(...lines.map((line) => context.measureText(line).width));
        context.fillStyle = shape.background;
        roundedRectPath(
          context,
          start.x - padding,
          start.y - padding * 0.7,
          width + padding * 2,
          lines.length * lineHeight + padding * 1.4,
          size * 0.25,
        );
        context.fill();
        context.fillStyle = shape.color;
      }
      lines.forEach((line, index) => {
        context.fillText(line, start.x, start.y + index * lineHeight);
      });
      break;
    }
  }
  context.restore();
}

function drawCropOverlay(
  context: CanvasRenderingContext2D,
  base: HTMLCanvasElement,
  rect: CropRect,
): void {
  context.save();
  context.fillStyle = 'rgba(3, 7, 18, 0.55)';
  context.fillRect(0, 0, base.width, rect.y);
  context.fillRect(0, rect.y + rect.h, base.width, base.height - rect.y - rect.h);
  context.fillRect(0, rect.y, rect.x, rect.h);
  context.fillRect(rect.x + rect.w, rect.y, base.width - rect.x - rect.w, rect.h);
  context.strokeStyle = '#ffffff';
  context.lineWidth = Math.max(1, base.width / 600);
  context.setLineDash([base.width / 120, base.width / 200]);
  context.strokeRect(rect.x, rect.y, rect.w, rect.h);
  context.restore();
}

@Component({
  selector: 'app-image-annotator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  host: {
    class: 'flex min-h-0 flex-1 flex-col',
    '(document:keydown)': 'onKeydown($event)',
    '(window:resize)': 'onResize()',
  },
  template: `
    <div
      #stage
      class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-ink/40 p-3"
    >
      <canvas
        #canvas
        class="block max-h-full max-w-full touch-none rounded-lg shadow-lg"
        [class.cursor-crosshair]="tool() !== 'text'"
        [class.cursor-text]="tool() === 'text'"
        (pointerdown)="onPointerDown($event)"
        (pointermove)="onPointerMove($event)"
        (pointerup)="onPointerUp($event)"
        (pointercancel)="onPointerUp($event)"
      ></canvas>

      @if (textAnchor(); as anchor) {
        <div
          class="absolute z-10 flex flex-col gap-1"
          [style.left.px]="anchor.left"
          [style.top.px]="anchor.top"
        >
          <input
            #textField
            type="text"
            class="min-w-32 rounded-md border border-accent/60 bg-white px-2 py-1 shadow-lg outline-none"
            [style.font-size.px]="textFieldSize()"
            [style.color]="textColor()"
            [value]="textValue()"
            (input)="onTextInput($event)"
            (keydown)="onTextKeydown($event)"
          />
          <div
            class="flex max-w-[26rem] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-white/10 bg-ink/95 px-2.5 py-1.5 shadow-lg"
          >
            <div class="flex items-center gap-1.5">
              <span class="text-[10px] tracking-wide text-mist/50 uppercase">
                {{ 'annotator.fontSize' | transloco }}
              </span>
              <select
                class="cursor-pointer rounded border border-white/15 bg-ink px-1.5 py-0.5 text-xs text-white outline-none"
                [value]="textSizePx()"
                (change)="onTextSizeChange($event)"
              >
                @for (size of textSizes; track size) {
                  <option [value]="size">{{ size }}px</option>
                }
              </select>
            </div>
            <div class="flex items-center gap-1.5">
              <span class="text-[10px] tracking-wide text-mist/50 uppercase">
                {{ 'annotator.fontColor' | transloco }}
              </span>
              <input
                type="color"
                class="h-5 w-5 cursor-pointer rounded border border-white/20 bg-transparent p-0"
                [value]="textColor()"
                [attr.title]="'annotator.fontColor' | transloco"
                (input)="onTextColorInput($event)"
              />
            </div>
            <div class="relative flex items-center gap-1.5">
              <span class="text-[10px] tracking-wide text-mist/50 uppercase">
                {{ 'annotator.background' | transloco }}
              </span>
              <button
                type="button"
                class="checkerboard h-5 w-5 overflow-hidden rounded border border-white/20"
                [attr.title]="'annotator.background' | transloco"
                (click)="bgPickerOpen.set(!bgPickerOpen())"
              >
                <span
                  class="block h-full w-full"
                  [style.background-color]="textBackgroundCss()"
                ></span>
              </button>
              @if (bgPickerOpen()) {
                <div
                  class="absolute top-full left-0 z-20 mt-1 flex w-44 flex-col gap-2 rounded-md border border-white/10 bg-ink/95 p-2 shadow-xl"
                >
                  <div class="flex items-center gap-2">
                    <span class="checkerboard grid h-8 w-8 shrink-0 overflow-hidden rounded">
                      <span
                        class="h-full w-full"
                        [style.background-color]="textBackgroundCss()"
                      ></span>
                    </span>
                    <input
                      type="color"
                      class="h-7 w-7 cursor-pointer rounded border border-white/20 bg-transparent p-0"
                      [value]="textBackgroundColor()"
                      [attr.title]="'annotator.background' | transloco"
                      (input)="onTextBackgroundColor($event)"
                    />
                  </div>
                  <div class="flex items-center gap-2">
                    <svg
                      class="h-4 w-4 shrink-0 text-mist/60"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
                    </svg>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      class="h-1 flex-1 cursor-pointer accent-accent"
                      [attr.title]="'annotator.opacity' | transloco"
                      [attr.aria-label]="'annotator.opacity' | transloco"
                      [value]="textBackgroundAlpha()"
                      (input)="onTextBackgroundAlpha($event)"
                    />
                    <span class="w-8 shrink-0 text-right text-[10px] text-mist/60">
                      {{ alphaPercent() }}%
                    </span>
                  </div>
                </div>
              }
            </div>
          </div>
        </div>
      }
    </div>

    <div
      class="flex shrink-0 flex-wrap items-center gap-2 border-t border-white/5 px-3 py-2"
    >
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="annotator-btn"
          [class.annotator-btn-active]="tool() === 'pen'"
          [attr.title]="'annotator.pen' | transloco"
          [attr.aria-label]="'annotator.pen' | transloco"
          (click)="setTool('pen')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 20h4L19 9l-4-4L4 16z" />
            <path d="M14 5l5 5" />
          </svg>
        </button>
        <button
          type="button"
          class="annotator-btn"
          [class.annotator-btn-active]="tool() === 'highlighter'"
          [attr.title]="'annotator.highlight' | transloco"
          [attr.aria-label]="'annotator.highlight' | transloco"
          (click)="setTool('highlighter')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 20h16" />
            <path d="M9 16l-3-3 7-7 3 3z" />
            <path d="M14 6l4 4" />
          </svg>
        </button>
        <button
          type="button"
          class="annotator-btn"
          [class.annotator-btn-active]="tool() === 'arrow'"
          [attr.title]="'annotator.arrow' | transloco"
          [attr.aria-label]="'annotator.arrow' | transloco"
          (click)="setTool('arrow')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 19 19 5" />
            <path d="M11 5h8v8" />
          </svg>
        </button>
        <button
          type="button"
          class="annotator-btn"
          [class.annotator-btn-active]="tool() === 'rectangle'"
          [attr.title]="'annotator.rectangle' | transloco"
          [attr.aria-label]="'annotator.rectangle' | transloco"
          (click)="setTool('rectangle')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="5" width="16" height="14" rx="1.5" />
          </svg>
        </button>
        <button
          type="button"
          class="annotator-btn"
          [class.annotator-btn-active]="tool() === 'ellipse'"
          [attr.title]="'annotator.ellipse' | transloco"
          [attr.aria-label]="'annotator.ellipse' | transloco"
          (click)="setTool('ellipse')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <ellipse cx="12" cy="12" rx="8" ry="6" />
          </svg>
        </button>
        <button
          type="button"
          class="annotator-btn"
          [class.annotator-btn-active]="tool() === 'text'"
          [attr.title]="'annotator.text' | transloco"
          [attr.aria-label]="'annotator.text' | transloco"
          (click)="setTool('text')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 5h14" />
            <path d="M12 5v14" />
            <path d="M9 19h6" />
          </svg>
        </button>
        <button
          type="button"
          class="annotator-btn"
          [class.annotator-btn-active]="tool() === 'crop'"
          [attr.title]="'annotator.crop' | transloco"
          [attr.aria-label]="'annotator.crop' | transloco"
          (click)="setTool('crop')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 2v16h16" />
            <path d="M2 6h16v16" />
          </svg>
        </button>
      </div>

      <div class="mx-0.5 h-6 w-px bg-white/10"></div>

      <div class="flex items-center gap-1.5">
        @for (preset of presets; track preset) {
          <button
            type="button"
            class="h-6 w-6 rounded-full border border-white/20 ring-2 ring-transparent transition"
            [class.ring-accent]="color() === preset"
            [style.background-color]="preset"
            [attr.title]="'annotator.color' | transloco"
            [attr.aria-label]="'annotator.color' | transloco"
            (click)="setColor(preset)"
          ></button>
        }
        <input
          type="color"
          class="h-6 w-6 cursor-pointer rounded-full border border-white/20 bg-transparent p-0"
          [value]="color()"
          [attr.title]="'annotator.color' | transloco"
          [attr.aria-label]="'annotator.color' | transloco"
          (input)="onColorInput($event)"
        />
      </div>

      <div class="mx-0.5 h-6 w-px bg-white/10"></div>

      <div class="flex items-center gap-2">
        <svg
          class="h-4 w-4 shrink-0 text-mist/60"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M4 12h16" stroke-width="2" />
          <path d="M4 7h16" stroke-width="4" />
          <path d="M4 17h16" stroke-width="6" />
        </svg>
        <input
          type="range"
          min="1"
          max="10"
          step="1"
          class="h-1.5 w-20 cursor-pointer accent-accent"
          [value]="widthLevel()"
          [attr.title]="'annotator.thickness' | transloco"
          [attr.aria-label]="'annotator.thickness' | transloco"
          (input)="onThicknessInput($event)"
        />
      </div>

      <div class="flex-1"></div>

      @if (cropRect()) {
        <button
          type="button"
          class="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-ink transition hover:bg-accent/90"
          (click)="applyCrop()"
        >
          {{ 'annotator.applyCrop' | transloco }}
        </button>
        <button
          type="button"
          class="rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition hover:bg-white/5"
          (click)="cancelCrop()"
        >
          {{ 'common.cancel' | transloco }}
        </button>
      }

      <button
        type="button"
        class="annotator-btn disabled:cursor-not-allowed disabled:opacity-30"
        [attr.title]="'annotator.undo' | transloco"
        [attr.aria-label]="'annotator.undo' | transloco"
        [disabled]="!canUndo()"
        (click)="undo()"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
        </svg>
      </button>

      <button
        type="button"
        class="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-ink transition hover:bg-accent/90"
        (click)="apply()"
      >
        {{ 'annotator.apply' | transloco }}
      </button>
    </div>
  `,
  styles: [
    `
      .annotator-btn {
        display: grid;
        place-items: center;
        height: 1.75rem;
        width: 1.75rem;
        border-radius: 0.5rem;
        border: 1px solid color-mix(in oklab, white 10%, transparent);
        background: color-mix(in oklab, white 5%, transparent);
        color: color-mix(in oklab, var(--color-mist) 70%, transparent);
        transition:
          background 0.15s,
          color 0.15s,
          border-color 0.15s;
      }
      .annotator-btn:hover {
        border-color: color-mix(in oklab, var(--color-accent) 45%, transparent);
        color: white;
      }
      .annotator-btn-active {
        border-color: color-mix(in oklab, var(--color-accent) 60%, transparent);
        background: color-mix(in oklab, var(--color-accent) 18%, transparent);
        color: var(--color-accent);
      }
      .checkerboard {
        background-color: #9ca3af;
        background-image: conic-gradient(
          #d1d5db 25%,
          #9ca3af 0 50%,
          #d1d5db 0 75%,
          #9ca3af 0
        );
        background-size: 8px 8px;
      }
    `,
  ],
})
export class ImageAnnotator {
  readonly attachment = input.required<MessageAttachment>();
  readonly applied = output<MessageAttachment>();

  protected readonly presets = PRESET_COLORS;
  protected readonly tool = signal<Tool>('pen');
  protected readonly color = signal<string>(PRESET_COLORS[0]);
  protected readonly widthLevel = signal(5);
  protected readonly textAnchor = signal<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  protected readonly textValue = signal('');
  protected readonly textSizes = TEXT_SIZES;
  protected readonly textSizePx = signal(28);
  protected readonly textColor = signal('#000000');
  protected readonly textBackgroundColor = signal('#ffffff');
  protected readonly textBackgroundAlpha = signal(1);
  protected readonly bgPickerOpen = signal(false);
  protected readonly textBackgroundCss = computed(() =>
    hexToRgba(this.textBackgroundColor(), this.textBackgroundAlpha()),
  );
  protected readonly alphaPercent = computed(() =>
    Math.round(this.textBackgroundAlpha() * 100),
  );

  private readonly history = signal<EditorState[]>([]);
  private readonly draft = signal<Shape | null>(null);
  protected readonly cropRect = signal<CropRect | null>(null);
  protected readonly canUndo = computed(() => this.history().length > 1);

  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly stage = viewChild<ElementRef<HTMLDivElement>>('stage');
  private readonly textField = viewChild<ElementRef<HTMLInputElement>>('textField');

  private activePointer: number | null = null;
  private cropStart: Point | null = null;

  constructor() {
    effect((onCleanup) => {
      const file = this.attachment();
      const stage = this.stage()?.nativeElement;
      if (!stage) {
        return;
      }
      const image = new Image();
      let disposed = false;
      onCleanup(() => {
        disposed = true;
        image.onload = null;
      });
      image.onload = () => {
        if (disposed) {
          return;
        }
        const base = window.document.createElement('canvas');
        base.width = image.naturalWidth;
        base.height = image.naturalHeight;
        const context = base.getContext('2d');
        if (!context) {
          return;
        }
        context.drawImage(image, 0, 0);
        this.draft.set(null);
        this.cropRect.set(null);
        this.fit(base);
        this.history.set([{ base, shapes: [] }]);
      };
      image.src = `data:${file.mimeType};base64,${file.data}`;
    });

    effect(() => {
      this.history();
      this.draft();
      this.cropRect();
      this.canvas();
      this.redraw();
    });

    effect(() => {
      const anchor = this.textAnchor();
      const field = this.textField()?.nativeElement;
      if (anchor && field) {
        field.focus();
      }
    });
  }

  protected setTool(tool: Tool): void {
    if (this.textAnchor()) {
      this.commitText();
    }
    this.tool.set(tool);
    this.draft.set(null);
    if (tool !== 'crop') {
      this.cropRect.set(null);
    }
    this.cropStart = null;
  }

  protected setColor(color: string): void {
    this.color.set(color);
  }

  protected onColorInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.color.set(input.value);
  }

  protected onThicknessInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.widthLevel.set(Number(input.value));
  }

  protected onTextSizeChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.textSizePx.set(Number(select.value));
  }

  protected onTextColorInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.textColor.set(input.value);
  }

  protected onTextBackgroundColor(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.textBackgroundColor.set(input.value);
  }

  protected onTextBackgroundAlpha(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.textBackgroundAlpha.set(Number(input.value));
  }

  protected onTextInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.textValue.set(input.value);
  }

  protected onTextKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitText();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelText();
    }
  }

  protected commitText(anchor = this.textAnchor()): void {
    if (this.textAnchor() !== anchor) {
      return;
    }
    const value = this.textValue().trim();
    const state = this.current();
    const font = Math.max(8, this.textSizePx() / this.displayScale());
    this.bgPickerOpen.set(false);
    this.textAnchor.set(null);
    this.textValue.set('');
    if (!anchor || !value || !state) {
      return;
    }
    const shape: Shape = {
      tool: 'text',
      color: this.textColor(),
      width: font,
      points: [{ x: anchor.x, y: anchor.y }],
      text: value,
      background: this.textBackgroundCss(),
    };
    this.history.update((list) => [...list, { base: state.base, shapes: [...state.shapes, shape] }]);
  }

  protected cancelText(): void {
    this.bgPickerOpen.set(false);
    this.textAnchor.set(null);
    this.textValue.set('');
  }

  protected textFieldSize(): number {
    return this.textSizePx();
  }

  private displayScale(): number {
    const canvas = this.canvas()?.nativeElement;
    const base = this.current()?.base;
    if (!canvas || !base) {
      return 1;
    }
    const width = canvas.getBoundingClientRect().width;
    return width > 0 ? width / base.width : 1;
  }

  private beginText(point: Point): void {
    const canvas = this.canvas()?.nativeElement;
    const stage = this.stage()?.nativeElement;
    const base = this.current()?.base;
    if (!canvas || !stage || !base) {
      return;
    }
    if (this.textAnchor()) {
      this.commitText();
    }
    const canvasRect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    this.textValue.set('');
    this.textAnchor.set({
      x: point.x,
      y: point.y,
      left: canvasRect.left - stageRect.left + (point.x / base.width) * canvasRect.width,
      top: canvasRect.top - stageRect.top + (point.y / base.height) * canvasRect.height,
    });
  }

  protected undo(): void {
    this.history.update((list) => (list.length > 1 ? list.slice(0, -1) : list));
    const base = this.current()?.base;
    if (base) {
      this.fit(base);
    }
  }

  protected onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    const canvas = this.canvas()?.nativeElement;
    const base = this.current()?.base;
    if (!canvas || !base) {
      return;
    }
    const point = this.toNatural(event, base);
    this.bgPickerOpen.set(false);
    if (this.textAnchor()) {
      this.commitText();
    }
    if (this.tool() === 'text') {
      this.beginText(point);
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    this.activePointer = event.pointerId;
    if (this.tool() === 'crop') {
      this.cropStart = point;
      this.cropRect.set({ x: point.x, y: point.y, w: 0, h: 0 });
      return;
    }
    const tool = this.tool() as Exclude<Tool, 'crop'>;
    this.draft.set({
      tool,
      color: this.color(),
      width: this.strokeWidth(tool, base.width),
      points: [point, point],
    });
  }

  protected onPointerMove(event: PointerEvent): void {
    if (this.activePointer !== event.pointerId) {
      return;
    }
    const base = this.current()?.base;
    if (!base) {
      return;
    }
    const point = this.toNatural(event, base);
    if (this.tool() === 'crop') {
      if (this.cropStart) {
        this.cropRect.set(this.rectFrom(this.cropStart, point));
      }
      return;
    }
    const draft = this.draft();
    if (!draft) {
      return;
    }
    if (draft.tool === 'pen' || draft.tool === 'highlighter') {
      this.draft.set({ ...draft, points: [...draft.points, point] });
    } else {
      this.draft.set({ ...draft, points: [draft.points[0], point] });
    }
  }

  protected onPointerUp(event: PointerEvent): void {
    if (this.activePointer !== event.pointerId) {
      return;
    }
    this.activePointer = null;
    const canvas = this.canvas()?.nativeElement;
    if (canvas?.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    if (this.tool() === 'crop') {
      this.cropStart = null;
      const rect = this.cropRect();
      if (!rect || rect.w < MIN_SHAPE_SIZE || rect.h < MIN_SHAPE_SIZE) {
        this.cropRect.set(null);
      }
      return;
    }
    const draft = this.draft();
    this.draft.set(null);
    const state = this.current();
    if (!draft || !state || draft.points.length < 2) {
      return;
    }
    const start = draft.points[0];
    const end = draft.points[draft.points.length - 1];
    if (
      draft.tool !== 'pen' &&
      draft.tool !== 'highlighter' &&
      Math.abs(end.x - start.x) < MIN_SHAPE_SIZE &&
      Math.abs(end.y - start.y) < MIN_SHAPE_SIZE
    ) {
      return;
    }
    this.history.update((list) => [...list, { base: state.base, shapes: [...state.shapes, draft] }]);
  }

  protected applyCrop(): void {
    if (this.textAnchor()) {
      this.commitText();
    }
    const rect = this.cropRect();
    const state = this.current();
    if (!rect || !state || rect.w < MIN_SHAPE_SIZE || rect.h < MIN_SHAPE_SIZE) {
      return;
    }
    const flat = window.document.createElement('canvas');
    flat.width = state.base.width;
    flat.height = state.base.height;
    const flatContext = flat.getContext('2d');
    if (!flatContext) {
      return;
    }
    flatContext.drawImage(state.base, 0, 0);
    for (const shape of state.shapes) {
      drawShape(flatContext, shape);
    }
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    const width = Math.min(flat.width - x, Math.round(rect.w));
    const height = Math.min(flat.height - y, Math.round(rect.h));
    if (width < MIN_SHAPE_SIZE || height < MIN_SHAPE_SIZE) {
      return;
    }
    const cropped = window.document.createElement('canvas');
    cropped.width = width;
    cropped.height = height;
    cropped.getContext('2d')?.drawImage(flat, x, y, width, height, 0, 0, width, height);
    this.cropRect.set(null);
    this.fit(cropped);
    this.history.update((list) => [...list, { base: cropped, shapes: [] }]);
  }

  protected cancelCrop(): void {
    this.cropRect.set(null);
    this.cropStart = null;
  }

  protected apply(): void {
    if (this.textAnchor()) {
      this.commitText();
    }
    const state = this.current();
    const file = this.attachment();
    if (!state) {
      return;
    }
    const output = window.document.createElement('canvas');
    output.width = state.base.width;
    output.height = state.base.height;
    const context = output.getContext('2d');
    if (!context) {
      return;
    }
    context.drawImage(state.base, 0, 0);
    for (const shape of state.shapes) {
      drawShape(context, shape);
    }
    const dataUrl = output.toDataURL('image/png');
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
    this.applied.emit({
      id: `annotated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: `${file.name.replace(/\.[^./\\]+$/, '')}.png`,
      mimeType: 'image/png',
      size: Math.ceil((data.length * 3) / 4),
      kind: 'image',
      lines: null,
      data,
    });
  }

  protected onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      this.undo();
    }
  }

  protected onResize(): void {
    const base = this.current()?.base;
    if (base) {
      this.fit(base);
      this.redraw();
    }
  }

  private current(): EditorState | null {
    return this.history().at(-1) ?? null;
  }

  private redraw(): void {
    const canvas = this.canvas()?.nativeElement;
    const state = this.current();
    if (!canvas || !state) {
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    const scale = canvas.width / state.base.width;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.drawImage(state.base, 0, 0);
    for (const shape of state.shapes) {
      drawShape(context, shape);
    }
    const draft = this.draft();
    if (draft) {
      drawShape(context, draft);
    }
    const crop = this.cropRect();
    if (crop && this.tool() === 'crop') {
      drawCropOverlay(context, state.base, crop);
    }
  }

  private fit(base: HTMLCanvasElement): void {
    const canvas = this.canvas()?.nativeElement;
    const stage = this.stage()?.nativeElement;
    if (!canvas || !stage) {
      return;
    }
    const maxWidth = Math.max(stage.clientWidth - 24, 200);
    const maxHeight = Math.max(stage.clientHeight - 24, 200);
    const scale = Math.min(maxWidth / base.width, maxHeight / base.height, 1);
    const cssWidth = Math.max(1, Math.floor(base.width * scale));
    const cssHeight = Math.max(1, Math.floor(base.height * scale));
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(cssWidth * ratio);
    canvas.height = Math.floor(cssHeight * ratio);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }

  private toNatural(event: PointerEvent, base: HTMLCanvasElement): Point {
    const canvas = this.canvas()!.nativeElement;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * base.width,
      y: ((event.clientY - rect.top) / rect.height) * base.height,
    };
  }

  private rectFrom(a: Point, b: Point): CropRect {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    };
  }

  private strokeWidth(tool: Exclude<Tool, 'crop'>, baseWidth: number): number {
    const unit = Math.max(2, baseWidth * (0.0015 + this.widthLevel() * 0.0012));
    return tool === 'highlighter' ? unit * 4 : unit;
  }
}
