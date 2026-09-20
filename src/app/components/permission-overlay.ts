import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PermissionRequestEvent } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';

@Component({
  selector: 'app-permission-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <div class="pointer-events-none absolute inset-x-0 bottom-full z-40 px-5 pb-3">
      <div
        class="pointer-events-auto mx-auto max-h-[70vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-accent/30 bg-navy/95 shadow-2xl shadow-black/50 backdrop-blur"
      >
        <header class="flex items-center gap-3 px-5 pt-4">
          <span
            class="rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider"
            [class]="
              request().promptKind === 'command'
                ? 'bg-accent/15 text-accent'
                : isWeb()
                  ? 'bg-sky-500/15 text-sky-300'
                  : request().promptKind === 'folder'
                    ? 'bg-white/10 text-mist'
                    : 'bg-rose-500/15 text-rose-300'
            "
          >
            {{ request().promptKind }}
          </span>
          <h2 class="min-w-0 flex-1 text-sm font-semibold text-white">{{ request().title }}</h2>
        </header>

        <div class="space-y-3 px-5 py-3">
          <p class="text-sm leading-relaxed text-mist/60">{{ request().detail }}</p>

          @if (request().command; as command) {
            <pre
              class="max-h-40 overflow-auto rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm text-mist"
              >{{ command }}</pre>
          }

          @if (request().folder; as folder) {
            <div
              class="rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm text-mist"
            >
              {{ folder }}
            </div>
          }

          @if (request().url; as url) {
            <div
              class="break-all rounded-xl border border-white/10 bg-ink/60 px-4 py-3 font-mono text-sm text-mist"
            >
              {{ url }}
            </div>
          }

          @if (request().promptKind === 'command' || isWeb()) {
            <div>
              <label class="mb-1.5 block text-sm text-mist/50">
                {{ (isWeb() ? 'permission.siteRuleLabel' : 'permission.ruleLabel') | transloco }}
              </label>
              <input
                class="field w-full rounded-xl px-4 py-2 font-mono text-sm"
                [value]="rule()"
                (input)="rule.set($any($event.target).value)"
              />
              <p class="mt-1.5 text-xs text-mist/30">
                {{ (isWeb() ? 'permission.siteRuleHint' : 'permission.ruleHint') | transloco }}
              </p>
            </div>
          }
        </div>

        <footer class="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-3">
          <button
            type="button"
            class="rounded-full border border-rose-500/30 px-4 py-2 text-sm text-rose-300 transition-colors hover:bg-rose-500/10"
            (click)="workspace.resolvePermission('deny')"
          >
            {{ 'permission.deny' | transloco }}
          </button>
          @if (isWeb()) {
            <button
              type="button"
              class="rounded-full border border-rose-500/30 px-4 py-2 text-sm text-rose-300 transition-colors hover:bg-rose-500/10"
              (click)="denyAlways()"
            >
              {{ 'permission.denyAlways' | transloco }}
            </button>
          }
          <button
            type="button"
            class="rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5"
            (click)="workspace.resolvePermission('allow_once')"
          >
            {{ 'permission.allowOnce' | transloco }}
          </button>
          @if (request().promptKind !== 'file') {
            <button
              type="button"
              class="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-ink transition-colors hover:bg-accent/90"
              (click)="allowAlways()"
            >
              @if (request().promptKind === 'folder') {
                {{ 'permission.addFolder' | transloco }}
              } @else {
                {{ 'permission.allowAlways' | transloco }}
              }
            </button>
          }
        </footer>
      </div>
    </div>
  `,
})
export class PermissionOverlay {
  readonly request = input.required<PermissionRequestEvent>();
  protected readonly workspace = inject(WorkspaceService);
  protected readonly rule = signal('');

  constructor() {
    effect(() => {
      this.rule.set(this.request().suggestedRule ?? '');
    });
  }

  protected allowAlways(): void {
    void this.workspace.resolvePermission('allow_always', this.rule());
  }

  protected denyAlways(): void {
    void this.workspace.resolvePermission('deny_always', this.rule());
  }

  protected isWeb(): boolean {
    const kind = this.request().promptKind;
    return kind === 'web' || kind === 'websearch';
  }
}
