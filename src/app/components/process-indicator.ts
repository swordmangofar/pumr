import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { WorkspaceService } from '../core/workspace.service';

@Component({
  selector: 'app-process-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    @if (workspace.processes().length > 0) {
      <div class="relative">
        <button
          type="button"
          class="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1.5 text-sm text-emerald-300 transition-colors hover:bg-emerald-500/20"
          (click)="open.set(!open())"
        >
          <span class="h-2 w-2 animate-pulse rounded-full bg-emerald-400"></span>
          {{ runningCount() }} {{ 'processes.running' | transloco }}
        </button>

        @if (open()) {
          <div class="fixed inset-0 z-30" (click)="open.set(false)"></div>
          <div
            class="absolute right-0 top-full z-40 mt-2 max-h-80 w-[28rem] overflow-y-auto rounded-2xl border border-white/10 bg-navy shadow-2xl"
          >
            @for (process of workspace.processes(); track process.id) {
              <div class="border-b border-white/5 px-4 py-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="truncate font-mono text-sm text-mist">
                      {{ process.command }}
                    </div>
                    <div class="mt-1 truncate text-xs text-mist/30">{{ process.cwd }}</div>
                  </div>
                  <button
                    type="button"
                    class="shrink-0 rounded-full border border-rose-500/40 px-3 py-1 text-xs text-rose-300 transition-colors hover:bg-rose-500/10"
                    (click)="stop(process.id)"
                  >
                    {{ 'processes.stop' | transloco }}
                  </button>
                </div>
                @if (process.output) {
                  <pre
                    class="mt-2 max-h-24 overflow-auto rounded-lg bg-ink/60 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-mist/40"
                    >{{ process.output }}</pre>
                }
              </div>
            }
          </div>
        }
      </div>
    }
  `,
})
export class ProcessIndicator {
  protected readonly workspace = inject(WorkspaceService);
  protected readonly open = signal(false);

  protected runningCount(): number {
    return this.workspace.processes().filter((process) => process.running).length;
  }

  protected async stop(processId: string): Promise<void> {
    await this.workspace.stopProcess(processId);
  }
}
