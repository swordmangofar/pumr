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
import { ImageAnnotator } from './image-annotator';

const PDF_PAGE_MAX_SCALE = 3;

type PdfModule = typeof import('pdfjs-dist');

let pdfModule: Promise<PdfModule> | null = null;

function loadPdfjs(): Promise<PdfModule> {
  pdfModule ??= import('pdfjs-dist').then((module) => {
    module.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs';
    return module;
  });
  return pdfModule;
}

function base64ToArrayBuffer(data: string): ArrayBuffer {
  const binary = atob(data);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

@Component({
  selector: 'app-attachment-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, ImageAnnotator],
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      (click)="closed.emit()"
    >
      @if (attachment(); as file) {
        <div
          [class]="panelClass()"
          class="flex max-w-full flex-col overflow-hidden glass-pop rounded-2xl shadow-2xl"
          (click)="$event.stopPropagation()"
        >
          <header
            class="flex shrink-0 items-center justify-between gap-4 border-b border-white/5 px-5 py-3"
          >
            <div class="flex min-w-0 items-center gap-2">
              @if (file.kind === 'pdf') {
                <span
                  class="shrink-0 rounded bg-rose-500/15 px-1 py-0.5 text-[10px] font-semibold tracking-wide text-rose-300"
                  >{{ 'common.pdf' | transloco }}</span
                >
              }
              <span class="truncate text-sm font-semibold text-white">{{ file.name }}</span>
              <span class="shrink-0 text-xs text-mist/40">
                {{ formatSize(file.size) }}
                @if (file.lines !== null) {
                  · {{ 'composer.attachmentLines' | transloco: { count: file.lines } }}
                }
              </span>
            </div>
            <button
              type="button"
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-mist/50 transition-colors hover:bg-white/5 hover:text-white"
              [attr.aria-label]="'common.close' | transloco"
              [attr.title]="'common.close' | transloco"
              (click)="closed.emit()"
            >
              ✕
            </button>
          </header>

          @switch (file.kind) {
            @case ('image') {
              @if (editable()) {
                <app-image-annotator
                  [attachment]="file"
                  (applied)="applied.emit($event)"
                />
              } @else {
                <div class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-ink/40 p-3">
                  @if (url(); as src) {
                    <img
                      [src]="src"
                      [alt]="file.name"
                      class="max-h-[80vh] max-w-full rounded-lg object-contain"
                    />
                  }
                </div>
              }
            }
            @case ('pdf') {
              <div class="relative min-h-0 flex-1 overflow-auto bg-ink/40">
                <div #pdfPages class="flex flex-col items-center gap-3 p-3"></div>
                @if (pdfState() === 'loading') {
                  <div
                    class="absolute inset-0 grid place-items-center text-sm text-mist/50"
                  >
                    {{ 'common.loading' | transloco }}
                  </div>
                } @else if (pdfState() === 'error') {
                  <div class="absolute inset-0 grid place-items-center text-sm text-rose-300">
                    {{ 'common.error' | transloco }}
                  </div>
                }
              </div>
            }
            @default {
              <pre
                class="min-h-0 flex-1 overflow-auto px-5 py-4 font-mono text-sm whitespace-pre-wrap text-mist"
                >{{ file.data }}</pre>
            }
          }
        </div>
      }
    </div>
  `,
})
export class AttachmentPreview {
  readonly attachment = input<MessageAttachment | null>(null);
  readonly editable = input<boolean>(false);
  readonly closed = output<void>();
  readonly applied = output<MessageAttachment>();

  protected readonly url = signal<string | null>(null);
  protected readonly pdfState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');

  private readonly pdfPages = viewChild<ElementRef<HTMLDivElement>>('pdfPages');

  protected readonly panelClass = computed(() =>
    this.attachment()?.kind === 'image' && !this.editable()
      ? 'max-h-[90vh]'
      : 'h-[82vh] w-[72rem]',
  );

  constructor() {
    effect((onCleanup) => {
      const file = this.attachment();
      if (!file || file.kind !== 'image' || this.editable()) {
        this.url.set(null);
        return;
      }
      const blob = new Blob([base64ToArrayBuffer(file.data)], { type: file.mimeType });
      const objectUrl = URL.createObjectURL(blob);
      this.url.set(objectUrl);
      onCleanup(() => URL.revokeObjectURL(objectUrl));
    });

    effect((onCleanup) => {
      const file = this.attachment();
      const container = this.pdfPages()?.nativeElement;
      if (!file || file.kind !== 'pdf' || !container) {
        return;
      }
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      void this.renderPdf(file, container, () => cancelled);
    });
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

  private async renderPdf(
    file: MessageAttachment,
    container: HTMLDivElement,
    cancelled: () => boolean,
  ): Promise<void> {
    this.pdfState.set('loading');
    container.replaceChildren();
    try {
      const pdfjsLib = await loadPdfjs();
      const task = pdfjsLib.getDocument({ data: base64ToArrayBuffer(file.data) });
      const pdf = await task.promise;
      if (cancelled()) {
        await task.destroy();
        return;
      }
      const width = Math.max(container.clientWidth - 24, 320);
      const ratio = window.devicePixelRatio || 1;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (cancelled()) {
          break;
        }
        const page = await pdf.getPage(pageNumber);
        const unscaled = page.getViewport({ scale: 1 });
        const scale = Math.min(width / unscaled.width, PDF_PAGE_MAX_SCALE);
        const viewport = page.getViewport({ scale });
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvas.className = 'block rounded-lg bg-white shadow-lg';
        const context = canvas.getContext('2d');
        if (!context) {
          continue;
        }
        await page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        }).promise;
        container.appendChild(canvas);
      }
      await task.destroy();
      if (!cancelled()) {
        this.pdfState.set('ready');
      }
    } catch (error) {
      console.error(error);
      if (!cancelled()) {
        this.pdfState.set('error');
      }
    }
  }
}
