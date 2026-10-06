import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { Hook, HookEvent } from '../../core/models';
import { WorkspaceService } from '../../core/workspace.service';
import { Toggle } from '../toggle';
import { TypedInput } from '../typed-input';
import { SettingsDraftService } from './settings-draft.service';

const EVENTS: readonly HookEvent[] = ['beforeTool', 'afterTool', 'turnEnd'];

/** A command that shows what a hook for each moment looks like. */
const EXAMPLES: Record<HookEvent, string> = {
  beforeTool: `grep -q 'push --force' && { echo 'No force pushes.' >&2; exit 2; }; exit 0`,
  afterTool: 'prettier --write "$PUMR_FILE"',
  turnEnd: 'pnpm lint >&2 || exit 2',
};

@Component({
  selector: 'app-hooks-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, TypedInput, Toggle],
  template: `
    <section>
      <div class="mb-2 flex items-center justify-between gap-3">
        <h3 class="text-sm font-semibold text-white">{{ 'settings.hooks.title' | transloco }}</h3>
        <button
          type="button"
          data-testid="add-hook"
          class="shrink-0 rounded-full border border-white/15 px-4 py-2 text-sm text-mist transition-colors hover:bg-white/5"
          (click)="add()"
        >
          ＋ {{ 'settings.hooks.add' | transloco }}
        </button>
      </div>
      <p class="text-xs leading-relaxed text-mist/30">{{ 'settings.hooks.hint' | transloco }}</p>
      <p class="mt-2 text-xs leading-relaxed text-mist/30">
        {{ 'settings.hooks.protocol' | transloco }}
      </p>
    </section>

    <section class="mt-6 space-y-3">
      @for (hook of hooks(); track hook.id) {
        <div class="glass-inset rounded-xl p-4" data-testid="hook">
          <div class="flex items-center gap-3">
            <app-toggle
              size="sm"
              [checked]="hook.enabled"
              (toggled)="patch(hook.id, { enabled: $event })"
            />
            <select
              class="field field-select min-w-0 flex-1 rounded-xl py-2 pr-9 pl-4 text-sm"
              data-testid="hook-event"
              [attr.aria-label]="'settings.hooks.event' | transloco"
              (typedValue)="patch(hook.id, { event: asEvent($event) })"
            >
              @for (event of events; track event) {
                <option [value]="event" [selected]="hook.event === event">
                  {{ 'settings.hooks.events.' + event | transloco }}
                </option>
              }
            </select>
            <button
              type="button"
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-mist/40 transition-colors hover:bg-white/5 hover:text-rose-400"
              [attr.aria-label]="'settings.hooks.remove' | transloco"
              (click)="remove(hook.id)"
            >
              ✕
            </button>
          </div>

          @if (hook.event !== 'turnEnd') {
            <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label class="block">
                <span class="mb-1 block text-xs text-mist/50">
                  {{ 'settings.hooks.tools' | transloco }}
                </span>
                <input
                  type="text"
                  class="field w-full rounded-xl px-4 py-2 font-mono text-sm"
                  data-testid="hook-tools"
                  autocomplete="off"
                  spellcheck="false"
                  [value]="hook.tools"
                  [placeholder]="'settings.hooks.toolsPlaceholder' | transloco"
                  (typedValue)="patch(hook.id, { tools: $event })"
                />
              </label>
              <label class="block">
                <span class="mb-1 block text-xs text-mist/50">
                  {{ 'settings.hooks.files' | transloco }}
                </span>
                <input
                  type="text"
                  class="field w-full rounded-xl px-4 py-2 font-mono text-sm"
                  data-testid="hook-files"
                  autocomplete="off"
                  spellcheck="false"
                  [value]="hook.files"
                  [placeholder]="'settings.hooks.filesPlaceholder' | transloco"
                  (typedValue)="patch(hook.id, { files: $event })"
                />
              </label>
            </div>
          }

          <label class="mt-3 block">
            <span class="mb-1 block text-xs text-mist/50">
              {{ 'settings.hooks.command' | transloco }}
            </span>
            <textarea
              class="field h-20 w-full resize-y rounded-xl px-4 py-2 font-mono text-sm leading-relaxed"
              data-testid="hook-command"
              autocomplete="off"
              spellcheck="false"
              [value]="hook.command"
              [placeholder]="examples[hook.event]"
              (typedValue)="patch(hook.id, { command: $event })"
            ></textarea>
          </label>

          <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="mb-1 block text-xs text-mist/50">
                {{ 'settings.hooks.timeout' | transloco }}
              </span>
              <input
                type="number"
                min="1"
                max="600"
                step="1"
                class="field w-full rounded-xl px-4 py-2 text-sm"
                [value]="hook.timeoutSeconds"
                (typedValue)="patch(hook.id, { timeoutSeconds: seconds($event) })"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs text-mist/50">
                {{ 'settings.hooks.project' | transloco }}
              </span>
              <select
                class="field field-select w-full rounded-xl py-2 pr-9 pl-4 text-sm"
                data-testid="hook-project"
                (typedValue)="patch(hook.id, { project: $event })"
              >
                <option value="" [selected]="!hook.project">
                  {{ 'settings.hooks.allProjects' | transloco }}
                </option>
                @for (project of projectsFor(hook); track project.path) {
                  <option [value]="project.path" [selected]="hook.project === project.path">
                    {{ project.name }}
                  </option>
                }
              </select>
            </label>
          </div>
        </div>
      } @empty {
        <p class="text-sm text-mist/30" data-testid="no-hooks">
          {{ 'settings.hooks.empty' | transloco }}
        </p>
      }
    </section>
  `,
})
export class HooksSettings {
  protected readonly draft = inject(SettingsDraftService);
  private readonly workspace = inject(WorkspaceService);

  protected readonly events = EVENTS;
  protected readonly examples = EXAMPLES;
  protected readonly hooks = computed(() => this.draft.draft().hooks ?? []);

  /** The projects to pick from, with the hook's own even when it is not open here. */
  protected projectsFor(hook: Hook): { path: string; name: string }[] {
    const projects = this.workspace.projects().map(({ path, name }) => ({ path, name }));
    if (hook.project && !projects.some((project) => project.path === hook.project)) {
      projects.push({ path: hook.project, name: hook.project });
    }
    return projects;
  }

  protected add(): void {
    const hook: Hook = {
      id: crypto.randomUUID(),
      enabled: true,
      event: 'afterTool',
      tools: '',
      files: '',
      command: '',
      timeoutSeconds: 60,
      project: '',
    };
    this.draft.patch('hooks', [...this.hooks(), hook]);
  }

  protected patch(id: string, change: Partial<Hook>): void {
    this.draft.patch(
      'hooks',
      this.hooks().map((hook) => (hook.id === id ? { ...hook, ...change } : hook)),
    );
  }

  protected remove(id: string): void {
    this.draft.patch(
      'hooks',
      this.hooks().filter((hook) => hook.id !== id),
    );
  }

  protected asEvent(value: string): HookEvent {
    return EVENTS.find((event) => event === value) ?? 'afterTool';
  }

  protected seconds(value: string): number {
    const seconds = Math.round(Number(value));
    return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 600) : 60;
  }
}
