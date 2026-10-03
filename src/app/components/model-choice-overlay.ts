import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PendingModelChoice } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';
import { ModelSelect } from './model-select';

/**
 * Asks which model a subagent should run on when the name the agent passed
 * fits several. The dropdown lists only those models until the user asks for
 * all of them.
 */
@Component({
  selector: 'app-model-choice-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ModelSelect, TranslocoPipe],
  template: `
    <div class="pointer-events-none absolute inset-0 z-40 flex flex-col justify-end px-5 pb-3">
      <!-- No backdrop blur here: it would keep the model menu, which reaches
           beyond this card, from blurring what lies behind it. -->
      <div
        class="pointer-events-auto mx-auto w-full max-w-2xl rounded-xl border border-white/10 bg-navy shadow-2xl shadow-black/50"
        data-testid="model-choice"
      >
        <div class="space-y-3 px-4 py-3">
          <div class="space-y-1">
            <p class="text-sm font-semibold leading-snug text-white">
              {{ 'modelChoice.title' | transloco }}
            </p>
            <p class="text-xs text-white/50">
              {{ 'modelChoice.detail' | transloco: { query: request().query } }}
            </p>
          </div>
          <app-model-select
            [value]="selected()"
            [only]="showAll() ? null : request().candidates"
            docked
            [label]="'modelChoice.title' | transloco"
            [placeholder]="'modelChoice.placeholder' | transloco"
            (valueChange)="selected.set($event)"
          />
          <button
            type="button"
            class="text-xs text-accent transition-colors hover:text-accent/80"
            (click)="showAll.set(!showAll())"
          >
            {{ (showAll() ? 'modelChoice.showSuggested' : 'modelChoice.showAll') | transloco }}
          </button>
        </div>

        <footer class="flex items-center gap-2 border-t border-white/10 px-4 py-2">
          <button
            type="button"
            class="rounded-full border border-white/15 px-3 py-1.5 text-xs text-mist transition-colors hover:bg-white/5"
            (click)="skip()"
          >
            {{ 'question.skip' | transloco }}
          </button>
          <span class="flex-1"></span>
          <button
            type="button"
            class="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-accent/90 disabled:opacity-40"
            [disabled]="!selected()"
            (click)="confirm()"
          >
            {{ 'modelChoice.confirm' | transloco }}
          </button>
        </footer>
      </div>
    </div>
  `,
})
export class ModelChoiceOverlay {
  readonly request = input.required<PendingModelChoice>();
  private readonly workspace = inject(WorkspaceService);

  /** The closest match is preselected; a new prompt starts over. */
  protected readonly selected = linkedSignal<string | null>(
    () => this.request().candidates[0] ?? null,
  );
  protected readonly showAll = signal(false);

  protected confirm(): void {
    const model = this.selected();
    if (model) {
      void this.workspace.resolveModelChoice(this.request().requestId, model);
    }
  }

  protected skip(): void {
    void this.workspace.resolveModelChoice(this.request().requestId, null);
  }
}
