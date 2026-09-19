import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { TranslocoPipe } from '@jsverse/transloco';
import { FileChange } from '../core/models';
import { MonacoService } from '../core/monaco.service';
import { WorkspaceService } from '../core/workspace.service';

@Component({
  selector: 'app-tool-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <div class="my-3 overflow-hidden rounded-xl border border-white/10 bg-navy/30">
      <button
        type="button"
        class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/5"
        (click)="expanded.set(!expanded())"
      >
        <span class="text-xs font-semibold uppercase tracking-wider" [class]="statusColor()">
          {{ name() }}
        </span>
        <span class="min-w-0 flex-1 truncate font-mono text-sm text-mist/50">
          {{ summary() }}
        </span>
        @if (status() === 'running') {
          <span class="h-2 w-2 animate-pulse rounded-full bg-accent"></span>
        }
        <span class="text-xs text-mist/30">{{ expanded() ? '▾' : '▸' }}</span>
      </button>

      @if (changes().length > 0) {
        <div class="flex flex-wrap gap-1.5 border-t border-white/10 px-4 py-2">
          @for (change of changes(); track change.path) {
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1 font-mono text-xs text-mist transition-colors hover:bg-white/10"
              (click)="selectChange(change)"
            >
              <span class="max-w-56 truncate">{{ change.path }}</span>
              @if (change.additions > 0) {
                <span class="text-emerald-400">+{{ change.additions }}</span>
              }
              @if (change.deletions > 0) {
                <span class="text-rose-400">-{{ change.deletions }}</span>
              }
            </button>
          }
        </div>
      }

      @if (expanded()) {
        @if (highlighted()) {
          <div class="border-t border-white/10 bg-ink/60 px-4 py-3">
            <div class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-mist/30">
              {{ 'tools.command' | transloco }}
            </div>
            <pre
              class="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
              [innerHTML]="highlighted()"
            ></pre>
          </div>
        }
        <div class="border-t border-white/10 px-4 py-3">
          <div class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-mist/30">
            {{ 'tools.output' | transloco }}
          </div>
          <pre
            class="max-h-72 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-mist/60"
            >{{ output() || ('common.loading' | transloco) }}</pre
          >
        </div>
      }
    </div>
  `,
})
export class ToolCard {
  readonly name = input.required<string>();
  readonly summary = input<string>('');
  readonly command = input<string>('');
  readonly output = input<string>('');
  readonly status = input<string>('ok');
  readonly changes = input<FileChange[]>([]);
  readonly sessionId = input<string | null>(null);

  protected readonly expanded = signal(false);
  protected readonly highlighted = signal<SafeHtml>('');
  private readonly workspace = inject(WorkspaceService);
  private readonly monaco = inject(MonacoService);
  private readonly sanitizer = inject(DomSanitizer);
  private lastCommand = '';

  constructor() {
    effect(() => {
      const expanded = this.expanded();
      const command = this.command();
      if (!expanded || this.name() !== 'bash' || !command) {
        this.highlighted.set('');
        this.lastCommand = '';
        return;
      }
      if (command === this.lastCommand) {
        return;
      }
      this.lastCommand = command;
      void this.monaco
        .colorize(command, 'shell')
        .then((html) => {
          this.highlighted.set(this.sanitizer.bypassSecurityTrustHtml(html));
        })
        .catch(() => {
          this.highlighted.set('');
          this.lastCommand = '';
        });
    });
  }

  protected statusColor(): string {
    switch (this.status()) {
      case 'running':
        return 'text-accent';
      case 'error':
        return 'text-rose-400';
      case 'denied':
        return 'text-mist/40';
      default:
        return 'text-emerald-400';
    }
  }

  protected selectChange(change: FileChange): void {
    const sessionId = this.sessionId();
    if (sessionId) {
      void this.workspace.selectChange(sessionId, change.path);
    }
  }
}
