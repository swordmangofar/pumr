import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { TerminalService } from '../core/terminal.service';

/** Runs a command shown in the chat in the terminal dock. */
@Component({
  selector: 'app-run-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <button
      type="button"
      class="inline-flex shrink-0 items-center justify-center rounded-lg border transition-colors"
      [class]="buttonClass()"
      [attr.title]="'terminal.run' | transloco"
      [attr.aria-label]="'terminal.run' | transloco"
      (click)="run($event)"
    >
      <svg
        class="h-4 w-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M6 3v18l14-9z" />
      </svg>
    </button>
  `,
})
export class RunButton {
  readonly command = input('');
  readonly buttonClass = input(
    'h-7 w-7 border-white/10 bg-white/5 text-mist/60 hover:border-accent/40 hover:bg-accent/15 hover:text-accent',
  );

  private readonly terminals = inject(TerminalService);

  protected run(event: MouseEvent): void {
    event.stopPropagation();
    void this.terminals.run(this.command());
  }
}
