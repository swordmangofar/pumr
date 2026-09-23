import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChildren,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PermissionDefaultAction, PermissionRequestEvent } from '../core/models';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';

type PermissionDecision = 'allow_once' | 'allow_session' | 'allow_always' | 'deny' | 'deny_always';

interface PermissionAction {
  id: string;
  labelKey: string;
  decision: PermissionDecision;
  variant: 'danger' | 'neutral' | 'primary';
}

@Component({
  selector: 'app-permission-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  host: {
    '(document:keydown)': 'onKeydown($event)',
  },
  template: `
    <div class="pointer-events-none absolute inset-0 z-40 flex flex-col justify-end px-5 pb-3">
      <div
        class="pointer-events-auto mx-auto max-h-full w-full max-w-4xl overflow-y-auto rounded-2xl border border-accent/30 bg-navy/95 shadow-2xl shadow-black/50 backdrop-blur"
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
            {{ ('permission.kind.' + request().promptKind) | transloco }}
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
                (input)="onRuleInput($event)"
              />
              <p class="mt-1.5 text-xs text-mist/30">
                {{ (isWeb() ? 'permission.siteRuleHint' : 'permission.ruleHint') | transloco }}
              </p>
            </div>
          }
        </div>

        <footer class="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-3">
          @for (action of actions(); track action.id; let index = $index) {
            <button
              #actionButton
              type="button"
              [class]="actionClass(action, index === activeIndex())"
              (click)="run(action)"
              (focus)="activeIndex.set(index)"
            >
              {{ action.labelKey | transloco }}
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
  private readonly settings = inject(SettingsService);
  protected readonly rule = signal('');
  protected readonly activeIndex = signal(0);

  private readonly actionButtons = viewChildren<ElementRef<HTMLButtonElement>>('actionButton');
  private focusedRequestId = '';

  protected readonly isWeb = computed(() => {
    const kind = this.request().promptKind;
    return kind === 'web' || kind === 'websearch';
  });

  private readonly defaultAction = computed<PermissionDefaultAction>(() => {
    const defaults = this.settings.settings()?.permissionDefaults;
    const kind = this.request().promptKind;
    if (kind === 'file') {
      return 'once';
    }
    if (this.isWeb()) {
      return defaults?.website ?? 'once';
    }
    if (kind === 'folder') {
      return defaults?.folder ?? 'once';
    }
    return defaults?.command ?? 'once';
  });

  protected readonly actions = computed<PermissionAction[]>(() => {
    const kind = this.request().promptKind;
    const session = this.defaultAction() === 'session';
    const actions: PermissionAction[] = [
      { id: 'deny', labelKey: 'permission.deny', decision: 'deny', variant: 'danger' },
    ];
    if (this.isWeb()) {
      actions.push({
        id: 'deny_always',
        labelKey: 'permission.denyAlways',
        decision: 'deny_always',
        variant: 'danger',
      });
    }
    actions.push({
      id: 'allow',
      labelKey: session ? 'permission.allowSession' : 'permission.allowOnce',
      decision: session ? 'allow_session' : 'allow_once',
      variant: 'neutral',
    });
    if (kind !== 'file') {
      actions.push({
        id: 'allow_always',
        labelKey: kind === 'folder' ? 'permission.addFolder' : 'permission.allowAlways',
        decision: 'allow_always',
        variant: 'primary',
      });
    }
    return actions;
  });

  private readonly defaultIndex = computed(() =>
    this.actions().findIndex((action) => action.id === 'allow'),
  );

  constructor() {
    effect(() => {
      this.rule.set(this.request().suggestedRule ?? '');
    });

    afterRenderEffect(() => {
      const request = this.request();
      const buttons = this.actionButtons();
      const index = this.defaultIndex();
      if (request.requestId === this.focusedRequestId) {
        return;
      }
      if (index < 0 || index >= buttons.length) {
        return;
      }
      this.focusedRequestId = request.requestId;
      this.activeIndex.set(index);
      buttons[index].nativeElement.focus();
    });
  }

  protected actionClass(action: PermissionAction, active: boolean): string {
    const base = 'rounded-full border px-4 py-2 text-sm transition-colors focus:outline-none';
    if (active) {
      return `${base} border-accent bg-accent font-semibold text-ink`;
    }
    switch (action.variant) {
      case 'danger':
        return `${base} border-rose-500/30 text-rose-300 hover:bg-rose-500/10`;
      case 'primary':
        return `${base} border-accent/50 text-accent hover:bg-accent/10`;
      default:
        return `${base} border-white/15 text-mist hover:bg-white/5`;
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || event.isComposing) {
      return;
    }
    if (this.settings.dialogOpen() || this.workspace.debugOpen()) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
    ) {
      return;
    }
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        this.move(-1);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        this.move(1);
        break;
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        this.activate();
        break;
    }
  }

  private move(delta: number): void {
    const count = this.actions().length;
    if (count === 0) {
      return;
    }
    const next = (this.activeIndex() + delta + count) % count;
    this.activeIndex.set(next);
    this.actionButtons()[next]?.nativeElement.focus();
  }

  private activate(): void {
    const action = this.actions()[this.activeIndex()];
    if (action) {
      this.run(action);
    }
  }

  protected onRuleInput(event: Event): void {
    this.rule.set((event.target as HTMLInputElement).value);
  }

  protected run(action: PermissionAction): void {
    if (action.decision === 'allow_always') {
      void this.workspace.resolvePermission('allow_always', this.rule());
      return;
    }
    if (action.decision === 'deny_always') {
      void this.workspace.resolvePermission('deny_always', this.rule());
      return;
    }
    void this.workspace.resolvePermission(action.decision);
  }
}
