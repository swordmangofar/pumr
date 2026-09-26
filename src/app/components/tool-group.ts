import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { TranslocoPipe } from '@jsverse/transloco';
import { ansiToHtml, stripAnsi } from '../core/ansi';
import { WorkspaceService } from '../core/workspace.service';
import { CopyButton } from './copy-button';
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
  imports: [TranslocoPipe, ToolStatus, CopyButton],
  template: `
    <div class="my-3 overflow-hidden glass-inset rounded-xl">
      <div class="flex items-center gap-3 px-4 py-2.5">
        <span class="text-xs font-semibold uppercase tracking-wider" [class]="statusColor()">{{
          name()
        }}</span>
        <span class="text-sm text-mist/50">
          {{ countKey() | transloco: { count: items().length } }}
        </span>
      </div>
      <div class="border-t border-white/5">
        @for (item of items(); track item.key) {
          <div class="border-b border-white/5 last:border-b-0">
            <div class="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-white/5">
              <button
                type="button"
                class="min-w-0 flex-1 truncate text-left font-mono text-sm text-mist/60 hover:text-mist"
                [attr.title]="item.label"
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
              @if (item.status === 'running') {
                <span class="h-2 w-2 animate-pulse rounded-full bg-accent"></span>
              }
              <app-tool-status [status]="item.status" />
              <button
                type="button"
                class="text-xs text-mist/30 hover:text-mist"
                [attr.aria-expanded]="expanded().has(item.key)"
                [attr.aria-label]="'tools.output' | transloco"
                (click)="toggle(item.key)"
              >
                {{ expanded().has(item.key) ? '▾' : '▸' }}
              </button>
            </div>
            @if (expanded().has(item.key)) {
              <div class="relative border-t border-white/5 bg-ink/60">
                @if (item.output) {
                  <app-copy-button
                    class="absolute top-2 right-2"
                    [text]="rendered().get(item.key)?.plain ?? ''"
                    buttonClass="h-6 w-6 border-white/10 bg-navy/80 text-mist/40 hover:border-accent/40 hover:bg-accent/15 hover:text-accent"
                  />
                  <pre
                    class="max-h-72 overflow-y-auto px-4 py-3 pr-10 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-mist/60"
                    [innerHTML]="rendered().get(item.key)?.html"
                  ></pre>
                } @else {
                  <pre
                    class="px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-mist/60"
                    >{{ 'common.loading' | transloco }}</pre>
                }
              </div>
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
  private readonly sanitizer = inject(DomSanitizer);

  /** `bash` groups count commands; the file tools count files. */
  protected readonly countKey = computed(() =>
    this.name() === 'bash' ? 'tools.commandCount' : 'tools.fileCount',
  );

  protected readonly statusColor = computed(() => {
    const statuses = this.items().map((item) => item.status);
    if (statuses.includes('running')) {
      return 'text-accent';
    }
    if (statuses.includes('error')) {
      return 'text-rose-400';
    }
    return 'text-emerald-400';
  });

  /** Output of the expanded items only, so collapsed output is never parsed. */
  protected readonly rendered = computed(() => {
    const open = this.expanded();
    const rendered = new Map<string, { html: SafeHtml; plain: string }>();
    for (const item of this.items()) {
      if (open.has(item.key) && item.output) {
        rendered.set(item.key, {
          html: this.sanitizer.bypassSecurityTrustHtml(ansiToHtml(item.output)),
          plain: stripAnsi(item.output),
        });
      }
    }
    return rendered;
  });

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

  /** Opens the diff of a changed file; entries without one (reads, commands) expand instead. */
  protected select(item: ToolGroupItem): void {
    const sessionId = this.sessionId();
    if (item.path && sessionId) {
      void this.workspace.selectChange(sessionId, item.path);
    } else {
      this.toggle(item.key);
    }
  }
}
