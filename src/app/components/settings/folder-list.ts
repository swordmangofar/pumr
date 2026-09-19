import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { open } from '@tauri-apps/plugin-dialog';
import { WorkspaceService } from '../../core/workspace.service';

@Component({
  selector: 'app-folder-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <div class="space-y-1.5">
      @for (folder of folders(); track folder) {
        <div
          class="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-ink/40 px-4 py-2"
        >
          <span class="truncate font-mono text-sm text-mist">{{ folder }}</span>
          <button
            type="button"
            class="shrink-0 text-mist/40 transition-colors hover:text-rose-400"
            (click)="remove(folder)"
          >
            ✕
          </button>
        </div>
      } @empty {
        <p class="text-sm text-mist/30">{{ emptyLabel() | transloco }}</p>
      }
    </div>
    <button
      type="button"
      class="mt-3 rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5"
      (click)="add()"
    >
      ＋ {{ addLabel() | transloco }}
    </button>
  `,
})
export class FolderList {
  private readonly workspace = inject(WorkspaceService);

  readonly folders = input.required<string[]>();
  readonly changed = output<string[]>();
  readonly addLabel = input<string>('common.addFolder');
  readonly emptyLabel = input<string>('common.noFolders');

  protected async add(): Promise<void> {
    const selected = await open({
      directory: true,
      multiple: true,
      title: 'Select folder',
      defaultPath: this.workspace.activeProject()?.path,
    });
    if (!selected) {
      return;
    }
    const paths = Array.isArray(selected) ? selected : [selected];
    const next = [...this.folders()];
    for (const path of paths) {
      if (!next.includes(path)) {
        next.push(path);
      }
    }
    this.changed.emit(next);
  }

  protected remove(folder: string): void {
    this.changed.emit(this.folders().filter((entry) => entry !== folder));
  }
}
