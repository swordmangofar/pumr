import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { FolderList } from './folder-list';
import { SettingsDraftService } from './settings-draft.service';

@Component({
  selector: 'app-workspace-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, FolderList],
  template: `
    <section>
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.workspace.allowed' | transloco }}
      </h3>
      <p class="mb-3 text-xs leading-relaxed text-mist/30">
        {{ 'settings.workspace.foldersHint' | transloco }}
      </p>
      <app-folder-list
        data-testid="allowed-folders"
        [folders]="draft.draft().extraFolders"
        (changed)="draft.patch('extraFolders', $event)"
      />
    </section>

    <section class="mt-8">
      <h3 class="mb-2 text-sm font-semibold text-white">
        {{ 'settings.workspace.readable' | transloco }}
      </h3>
      <p class="mb-3 text-xs leading-relaxed text-mist/30">
        {{ 'settings.workspace.readableHint' | transloco }}
      </p>
      <app-folder-list
        data-testid="read-folders"
        [folders]="draft.draft().readFolders"
        (changed)="draft.patch('readFolders', $event)"
      />
    </section>
  `,
})
export class WorkspaceSettings {
  protected readonly draft = inject(SettingsDraftService);
}
