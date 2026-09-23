import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

export type ToggleSize = 'xs' | 'sm' | 'md';

const TRACK_SIZES: Record<ToggleSize, string> = {
  xs: 'h-4 w-7',
  sm: 'h-5 w-9',
  md: 'h-6 w-11',
};

const THUMB_SIZES: Record<ToggleSize, string> = {
  xs: 'top-0.5 h-3 w-3',
  sm: 'top-0.5 h-4 w-4',
  md: 'top-0.5 h-5 w-5',
};

const THUMB_OFFSETS: Record<ToggleSize, { on: string; off: string }> = {
  xs: { on: 'left-3.5 bg-ink', off: 'left-0.5 bg-white' },
  sm: { on: 'left-4.5 bg-ink', off: 'left-0.5 bg-white' },
  md: { on: 'left-5.5 bg-ink', off: 'left-0.5 bg-white' },
};

@Component({
  selector: 'app-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0' },
  template: `
    <button
      type="button"
      role="switch"
      [attr.aria-checked]="checked()"
      [disabled]="disabled()"
      class="relative shrink-0 rounded-full transition-colors disabled:opacity-40"
      [class]="trackClass()"
      (click)="toggle()"
    >
      <span class="absolute rounded-full transition-all" [class]="thumbClass()"></span>
    </button>
  `,
})
export class Toggle {
  readonly checked = input.required<boolean>();
  readonly size = input<ToggleSize>('md');
  readonly disabled = input(false);
  readonly toggled = output<boolean>();

  protected readonly trackClass = computed(
    () => `${TRACK_SIZES[this.size()]} ${this.checked() ? 'bg-accent' : 'bg-white/15'}`,
  );

  protected readonly thumbClass = computed(() => {
    const size = this.size();
    const offset = this.checked() ? THUMB_OFFSETS[size].on : THUMB_OFFSETS[size].off;
    return `${THUMB_SIZES[size]} ${offset}`;
  });

  protected toggle(): void {
    if (this.disabled()) {
      return;
    }
    this.toggled.emit(!this.checked());
  }
}
