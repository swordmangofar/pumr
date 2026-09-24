import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

@Component({
  selector: 'app-copy-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <button
      type="button"
      class="inline-flex shrink-0 items-center justify-center rounded-lg border transition-colors"
      [class]="buttonClass()"
      [attr.title]="(copied() ? 'common.copied' : label()) | transloco"
      [attr.aria-label]="(copied() ? 'common.copied' : label()) | transloco"
      (click)="copy($event)"
    >
      @if (copied()) {
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
          <path d="M20 6 9 17l-5-5" />
        </svg>
      } @else {
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
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      }
    </button>
  `,
})
export class CopyButton {
  readonly text = input<string>('');
  readonly label = input('common.copy');
  readonly buttonClass = input(
    'h-7 w-7 border-white/10 bg-white/5 text-mist/60 hover:border-accent/40 hover:bg-accent/15 hover:text-accent',
  );

  protected readonly copied = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected copy(event: MouseEvent): void {
    event.stopPropagation();
    const text = this.text();
    if (!text) {
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        this.copied.set(true);
        if (this.timer) {
          clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => this.copied.set(false), 1500);
      })
      .catch(() => {
        // clipboard may be unavailable
      });
  }
}
