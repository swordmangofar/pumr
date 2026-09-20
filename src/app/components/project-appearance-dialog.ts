import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { Project } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';
import { PROJECT_COLORS, PROJECT_ICONS, ProjectIcon, projectColor } from './project-icon';

const ICON_IMAGE_SIZE = 256;

@Component({
  selector: 'app-project-appearance-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, ProjectIcon],
  host: {
    '(document:keydown.escape)': 'close()',
  },
  template: `
    @if (project(); as active) {
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
        (click)="close()"
      >
        <div
          class="flex max-h-[86vh] w-[32rem] max-w-full flex-col overflow-hidden glass-pop rounded-2xl shadow-2xl"
          (click)="$event.stopPropagation()"
        >
          <header
            class="flex shrink-0 items-center justify-between border-b border-white/5 px-6 py-4"
          >
            <div class="flex items-center gap-3">
              <app-project-icon [project]="preview()" [size]="28" />
              <h2 class="truncate text-base font-semibold text-white">
                {{ 'projectAppearance.title' | transloco }}
              </h2>
            </div>
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-full text-mist/50 transition-colors hover:bg-white/5 hover:text-white"
              (click)="close()"
            >
              ✕
            </button>
          </header>

          <div class="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
            <section>
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-widest text-mist/40">
                {{ 'projectAppearance.color' | transloco }}
              </h3>
              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  class="flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors"
                  [class]="
                    color() === null
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : 'border-white/10 text-mist/60 hover:border-white/25 hover:text-mist'
                  "
                  (click)="setColor(null)"
                >
                  {{ 'projectAppearance.auto' | transloco }}
                </button>
                @for (swatch of colors; track swatch) {
                  <button
                    type="button"
                    class="h-8 w-8 rounded-full border-2 transition-transform hover:scale-110"
                    [class]="color() === swatch ? 'border-white' : 'border-white/10'"
                    [style.background]="swatch"
                    [attr.aria-label]="swatch"
                    (click)="setColor(swatch)"
                  ></button>
                }
                <label
                  class="relative flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2 border-white/10"
                  [style.background]="color() ?? projectColor(active)"
                  [title]="'projectAppearance.customColor' | transloco"
                >
                  <span
                    class="pointer-events-none absolute inset-0 flex items-center justify-center"
                  >
                    <span
                      class="flex h-4 w-4 items-center justify-center rounded-full bg-black/40 text-[10px] font-bold text-white"
                      >＋</span
                    >
                  </span>
                  <input
                    type="color"
                    class="absolute inset-0 cursor-pointer opacity-0"
                    [value]="color() ?? projectColor(active)"
                    (input)="onColorInput($event)"
                  />
                </label>
              </div>
            </section>

            <section>
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-widest text-mist/40">
                {{ 'projectAppearance.icon' | transloco }}
              </h3>
              <div class="grid grid-cols-8 gap-2">
                <button
                  type="button"
                  class="flex h-9 items-center justify-center rounded-lg border text-xs font-semibold transition-colors"
                  [class]="
                    icon() === null && !iconImage()
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : 'border-white/10 text-mist/60 hover:border-white/25 hover:text-mist'
                  "
                  [title]="'projectAppearance.letter' | transloco"
                  (click)="setIcon(null)"
                >
                  Aa
                </button>
                @for (entry of icons; track entry.id) {
                  <button
                    type="button"
                    class="flex h-9 items-center justify-center rounded-lg border transition-colors"
                    [class]="
                      icon() === entry.id && !iconImage()
                        ? 'border-accent/60 bg-accent/15 text-accent'
                        : 'border-white/10 text-mist/60 hover:border-white/25 hover:text-mist'
                    "
                    [attr.aria-label]="entry.id"
                    (click)="setIcon(entry.id)"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      class="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      @for (path of entry.paths; track $index) {
                        <path [attr.d]="path" />
                      }
                    </svg>
                  </button>
                }
              </div>
            </section>

            <section>
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-widest text-mist/40">
                {{ 'projectAppearance.image' | transloco }}
              </h3>
              <div class="flex items-center gap-3">
                <app-project-icon [project]="preview()" [size]="48" radius="rounded-xl" />
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    class="rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5"
                    (click)="fileInput.click()"
                  >
                    {{ 'projectAppearance.upload' | transloco }}
                  </button>
                  @if (iconImage()) {
                    <button
                      type="button"
                      class="rounded-full px-3 py-2 text-sm text-rose-400 transition-colors hover:bg-rose-400/10"
                      (click)="setIconImage(null)"
                    >
                      {{ 'projectAppearance.removeImage' | transloco }}
                    </button>
                  }
                </div>
                <input
                  #fileInput
                  type="file"
                  accept="image/*"
                  class="hidden"
                  (change)="onFile($event)"
                />
              </div>
              @if (error(); as message) {
                <p class="mt-2 text-xs text-rose-400">{{ message | transloco }}</p>
              } @else {
                <p class="mt-2 text-xs text-mist/30">
                  {{ 'projectAppearance.imageHint' | transloco }}
                </p>
              }
            </section>
          </div>

          <footer
            class="flex shrink-0 items-center justify-end gap-2 border-t border-white/5 px-6 py-4"
          >
            <button
              type="button"
              class="rounded-full px-4 py-2 text-sm text-mist/70 transition-colors hover:bg-white/5 hover:text-white"
              (click)="close()"
            >
              {{ 'common.cancel' | transloco }}
            </button>
            <button
              type="button"
              class="rounded-full bg-accent px-5 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
              [disabled]="saving()"
              (click)="save()"
            >
              {{ 'common.confirm' | transloco }}
            </button>
          </footer>
        </div>
      </div>
    }
  `,
})
export class ProjectAppearanceDialog {
  private readonly workspace = inject(WorkspaceService);

  protected readonly icons = PROJECT_ICONS;
  protected readonly colors = PROJECT_COLORS;
  protected readonly projectColor = projectColor;

  protected readonly project = computed<Project | null>(() => {
    const id = this.workspace.projectEditorId();
    return id ? this.workspace.projectFor(id) : null;
  });

  protected readonly color = signal<string | null>(null);
  protected readonly icon = signal<string | null>(null);
  protected readonly iconImage = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly preview = computed<Project>(() => {
    const active = this.project();
    const base: Project = active ?? {
      id: 'preview',
      path: '',
      name: '?',
      createdAt: 0,
      lastOpenedAt: 0,
      sessionCount: 0,
      totalCost: 0,
      color: null,
      icon: null,
      iconImage: null,
    };
    return { ...base, color: this.color(), icon: this.icon(), iconImage: this.iconImage() };
  });

  constructor() {
    effect(() => {
      const active = this.project();
      this.color.set(active?.color ?? null);
      this.icon.set(active?.icon ?? null);
      this.iconImage.set(active?.iconImage ?? null);
      this.error.set(null);
    });
  }

  protected setColor(value: string | null): void {
    this.color.set(value);
  }

  protected onColorInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.color.set(value);
  }

  protected setIcon(value: string | null): void {
    this.icon.set(value);
    this.iconImage.set(null);
  }

  protected setIconImage(value: string | null): void {
    this.iconImage.set(value);
  }

  protected async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    this.error.set(null);
    if (!file.type.startsWith('image/')) {
      this.error.set('projectAppearance.notAnImage');
      return;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      this.iconImage.set(await cropToSquare(dataUrl, ICON_IMAGE_SIZE));
    } catch {
      this.error.set('projectAppearance.imageFailed');
    }
  }

  protected close(): void {
    this.workspace.closeProjectEditor();
  }

  protected async save(): Promise<void> {
    const active = this.project();
    if (!active || this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      await this.workspace.updateProjectAppearance(active.id, {
        color: this.color(),
        icon: this.icon(),
        iconImage: this.iconImage(),
      });
      this.close();
    } catch (error) {
      console.error(error);
      this.error.set('projectAppearance.saveFailed');
    } finally {
      this.saving.set(false);
    }
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(file);
  });
}

/** Center-crops an image to a square and downscales it, returning a PNG data URL. */
function cropToSquare(dataUrl: string, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('decode failed'));
    image.onload = () => {
      const side = Math.min(image.width, image.height);
      const sx = (image.width - side) / 2;
      const sy = (image.height - side) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('no canvas context'));
        return;
      }
      context.drawImage(image, sx, sy, side, side, 0, 0, size, size);
      resolve(canvas.toDataURL('image/png'));
    };
    image.src = dataUrl;
  });
}
