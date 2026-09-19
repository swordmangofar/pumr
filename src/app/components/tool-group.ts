import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { WorkspaceService } from '../core/workspace.service';
import { ToolStatus } from './tool-status';

export interface ToolGroupItem {
  key: string;
  label: string;
  output: string;
  status: string;
  additions: number;
  deletions: number;
  path: string | null;
}

@Component({
  selector: 'app-tool-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, ToolStatus],
  template: `
    <div class="my-3 overflow-hidden rounded-xl border border-white/10 bg-navy/30">
      <div class="flex items-center gap-3 px-4 py-2.5">
        <span class="text-xs font-semibold uppercase tracking-wider text-emerald-400">{{
          name()
        }}</span>
        <span class="text-sm text-mist/50">
          {{ items().length }} {{ 'tools.files' | transloco }}
        </span>
      </div>
      <div class="border-t border-white/10">
        @for (item of items(); track item.key) {
          <div class="border-b border-white/5 last:border-b-0">
            <div class="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-white/5">
              <button
                type="button"
                class="min-w-0 flex-1 truncate text-left font-mono text-sm text-mist/60 hover:text-mist"
                (click)="select(item)"
              >
                {{ item.label }}
              </button>
              @if (item.additions > 0) {
                <span class="text-xs text-emerald-400">+{{ item.additions }}</span>
              }
              @if (item.deletions > 0) {
                <span class="text-xs text-rose-400">-{{ item.deletions }}</span>
              }
              <app-tool-status [status]="item.status" />
              <button
                type="button"
                class="text-xs text-mist/30 hover:text-mist"
                (click)="toggle(item.key)"
              >
                {{ expanded().has(item.key) ? '▾' : '▸' }}
              </button>
            </div>
            @if (expanded().has(item.key)) {
              <pre
                class="max-h-72 overflow-y-auto border-t border-white/10 bg-ink/60 px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-mist/60"
                >{{ item.output || ('common.loading' | transloco) }}</pre>
            }
          </div>
        }
      </div>
    </div>
  `,
})
export class ToolGroup {
  readonly name = input.required<string>();
  readonly items = input.required<ToolGroupItem[]>();
  readonly sessionId = input<string | null>(null);

  protected readonly expanded = signal<Set<string>>(new Set());
  private readonly workspace = inject(WorkspaceService);

  protected toggle(key: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  protected select(item: ToolGroupItem): void {
    const sessionId = this.sessionId();
    if (item.path && sessionId) {
      void this.workspace.selectChange(sessionId, item.path);
    }
  }
}
