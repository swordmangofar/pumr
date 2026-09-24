import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { TranslocoPipe } from '@jsverse/transloco';
import { ansiToHtml } from '../core/ansi';
import { FileChange } from '../core/models';
import { MonacoService } from '../core/monaco.service';
import { WorkspaceService } from '../core/workspace.service';
import { CopyButton } from './copy-button';
import { ToolStatus } from './tool-status';

@Component({
  selector: 'app-tool-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, ToolStatus, CopyButton],
  template: `
    <div class="my-3 overflow-hidden glass-inset rounded-xl">
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
        <app-tool-status [status]="status()" />
        <span class="text-xs text-mist/30">{{ expanded() ? '▾' : '▸' }}</span>
      </button>

      @if (changes().length > 0) {
        <div class="flex flex-wrap gap-1.5 border-t border-white/5 px-4 py-2">
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
          <div class="border-t border-white/5 bg-ink/60 px-4 py-3">
            <div class="mb-1.5 flex items-center justify-between gap-2">
              <div class="text-[10px] font-semibold uppercase tracking-wider text-mist/30">
                {{ 'tools.command' | transloco }}
              </div>
              <app-copy-button
                [text]="command()"
                buttonClass="h-6 w-6 border-white/10 bg-white/5 text-mist/40 hover:border-accent/40 hover:bg-accent/15 hover:text-accent"
              />
            </div>
            <pre
              class="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
              [innerHTML]="highlighted()"
            ></pre>
          </div>
        }
        <div class="border-t border-white/5 px-4 py-3">
          <div class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-mist/30">
            {{ 'tools.output' | transloco }}
          </div>
          @if (output()) {
            <pre
              class="max-h-72 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-mist/60"
              [innerHTML]="outputHtml()"
            ></pre>
          } @else {
            <pre
              class="max-h-72 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-mist/60"
              >{{ 'common.loading' | transloco }}</pre>
          }
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
  protected readonly outputHtml = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(ansiToHtml(this.output())),
  );
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
      case 'canceled':
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
