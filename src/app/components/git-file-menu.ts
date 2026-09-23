import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { confirm } from '@tauri-apps/plugin-dialog';
import { GitBlameLine } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';
import { WorkspaceEditorService } from '../core/workspace-editor.service';
import { GitService } from '../core/git.service';

/** Rendered menu footprint, used to keep it inside the viewport. */
const MENU_WIDTH_PX = 240;
const MENU_HEIGHT_PX = 320;
const VIEWPORT_MARGIN_PX = 8;

type FileAction = 'stage' | 'unstage' | 'discard' | 'blame' | 'history' | 'ignore' | 'open' | 'reveal';

@Component({
  selector: 'app-git-file-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  host: {
    '(document:keydown.escape)': 'onEscape()',
  },
  template: `
    @if (menuVisible()) {
      <div class="fixed inset-0 z-40" (click)="close()" (contextmenu)="onBackdrop($event)"></div>

      <div
        class="glass-pop fixed z-50 w-60 overflow-hidden rounded-xl py-1 text-[13px] text-mist shadow-2xl"
        [style]="menuStyle()"
      >
        @if (staged()) {
          <button type="button" class="menu-item" (click)="run('unstage')">
            {{ 'git.unstage' | transloco }}
          </button>
        } @else {
          <button type="button" class="menu-item" (click)="run('stage')">
            {{ 'git.stage' | transloco }}
          </button>
          <button type="button" class="menu-item text-rose-400" (click)="run('discard')">
            {{ 'git.discard' | transloco }}
          </button>
        }

        <div class="menu-sep"></div>
        <button type="button" class="menu-item" (click)="run('blame')">
          {{ 'git.blame' | transloco }}
        </button>
        <button type="button" class="menu-item" (click)="run('history')">
          {{ 'git.history' | transloco }}
        </button>

        <div class="menu-sep"></div>
        <button type="button" class="menu-item" (click)="run('ignore')">
          {{ 'git.ignore' | transloco }}
        </button>
        <button type="button" class="menu-item" (click)="run('open')">
          {{ 'git.open' | transloco }}
        </button>
        <button type="button" class="menu-item" (click)="run('reveal')">
          {{ 'git.reveal' | transloco }}
        </button>
      </div>
    }

    @if (blameOpen()) {
      <div
        class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
        (click)="closeBlame()"
      >
        <div
          class="flex max-h-[80vh] w-[44rem] max-w-full flex-col glass-pop rounded-2xl shadow-2xl"
          (click)="$event.stopPropagation()"
        >
          <header class="flex shrink-0 items-center gap-3 border-b border-white/5 p-4">
            <span class="text-base font-semibold text-white">{{ 'git.blame' | transloco }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs text-mist/50">{{ path() }}</span>
            <button
              type="button"
              class="rounded-full border border-white/15 px-3 py-1 text-xs text-mist transition-colors hover:bg-white/5"
              (click)="closeBlame()"
            >
              {{ 'common.close' | transloco }}
            </button>
          </header>
          <div class="min-h-0 flex-1 overflow-auto">
            @if (blameLoading()) {
              <p class="p-4 text-sm text-mist/40">{{ 'common.loading' | transloco }}</p>
            } @else if (blameError(); as message) {
              <p class="p-4 text-sm text-rose-400">{{ message }}</p>
            } @else {
              <table class="w-full border-collapse font-mono text-[11px]">
                <tbody>
                  @for (line of blameLines(); track $index) {
                    <tr class="hover:bg-white/5">
                      <td class="w-16 shrink-0 border-r border-white/5 px-2 py-0.5 text-right text-mist/25">
                        {{ line.line }}
                      </td>
                      <td class="w-16 shrink-0 border-r border-white/5 px-2 py-0.5 text-mist/40">
                        {{ line.shortHash }}
                      </td>
                      <td class="w-32 shrink-0 truncate border-r border-white/5 px-2 py-0.5 text-mist/50">
                        {{ line.author }}
                      </td>
                      <td class="whitespace-pre px-2 py-0.5 text-mist/80">{{ line.content }}</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td class="p-4 text-mist/40">{{ 'git.blameEmpty' | transloco }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: `
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
    .menu-sep {
      margin: 0.25rem 0.5rem;
      border-top: 1px solid rgb(255 255 255 / 0.08);
    }
  `,
})
export class GitFileMenu {
  private readonly workspace = inject(WorkspaceService);
  private readonly editor = inject(WorkspaceEditorService);
  private readonly git = inject(GitService);
  private readonly transloco = inject(TranslocoService);

  readonly path = input.required<string>();
  readonly staged = input.required<boolean>();
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  readonly closed = output<void>();

  protected readonly menuVisible = signal(true);
  protected readonly blameOpen = signal(false);
  protected readonly blameLoading = signal(false);
  protected readonly blameError = signal<string | null>(null);
  protected readonly blameLines = signal<GitBlameLine[]>([]);

  protected readonly menuStyle = computed(() => {
    if (typeof window === 'undefined') {
      return { left: `${this.x()}px`, top: `${this.y()}px` };
    }
    const left = Math.max(
      VIEWPORT_MARGIN_PX,
      Math.min(this.x(), window.innerWidth - MENU_WIDTH_PX - VIEWPORT_MARGIN_PX),
    );
    const flipY = this.y() > window.innerHeight - MENU_HEIGHT_PX;
    return {
      left: `${left}px`,
      top: flipY ? 'auto' : `${this.y()}px`,
      bottom: flipY ? `${Math.max(VIEWPORT_MARGIN_PX, window.innerHeight - this.y())}px` : 'auto',
    };
  });

  private projectId(): string | null {
    return this.workspace.activeProject()?.id ?? null;
  }

  protected onBackdrop(event: MouseEvent): void {
    event.preventDefault();
    this.close();
  }

  protected onEscape(): void {
    if (this.blameOpen()) {
      this.closeBlame();
    } else {
      this.close();
    }
  }

  protected close(): void {
    this.closed.emit();
  }

  protected closeBlame(): void {
    this.blameOpen.set(false);
    this.closed.emit();
  }

  protected run(action: FileAction): void {
    const projectId = this.projectId();
    if (!projectId) {
      this.close();
      return;
    }
    switch (action) {
      case 'stage':
        void this.git.stagePath(projectId, this.path());
        this.close();
        break;
      case 'unstage':
        void this.git.unstagePath(projectId, this.path());
        this.close();
        break;
      case 'discard':
        void this.discard(projectId);
        break;
      case 'history':
        this.close();
        void this.git.openFileHistory(projectId, this.path());
        break;
      case 'ignore':
        void this.git.ignorePath(projectId, this.path());
        this.close();
        break;
      case 'open':
        this.openInEditor(projectId);
        break;
      case 'reveal':
        void this.git.revealPath(projectId, this.path());
        this.close();
        break;
      case 'blame':
        this.menuVisible.set(false);
        void this.loadBlame(projectId);
        break;
    }
  }

  private async discard(projectId: string): Promise<void> {
    const confirmed = await confirm(
      this.transloco.translate('git.discardConfirm', { path: this.path() }),
      { title: 'pumr', kind: 'warning' },
    );
    if (confirmed) {
      await this.git.discardPath(projectId, this.path());
    }
    this.close();
  }

  private openInEditor(projectId: string): void {
    this.workspace.setLeftTab('workspace');
    this.editor.open(projectId, this.path());
    this.close();
  }

  private async loadBlame(projectId: string): Promise<void> {
    this.blameOpen.set(true);
    this.blameLoading.set(true);
    this.blameError.set(null);
    this.blameLines.set([]);
    try {
      this.blameLines.set(await this.git.blame(projectId, this.path()));
    } catch (error) {
      this.blameError.set(String(error));
    } finally {
      this.blameLoading.set(false);
    }
  }
}
