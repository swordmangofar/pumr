import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-attention-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full"
      [class]="kind() === 'question' ? questionClass() : permissionClass()"
      aria-hidden="true"
    ></span>
  `,
})
export class AttentionIndicator {
  readonly kind = input<'permission' | 'question'>('permission');
  readonly onAccent = input(false);

  protected permissionClass(): string {
    return this.onAccent() ? 'bg-ink' : 'bg-accent';
  }

  protected questionClass(): string {
    return this.onAccent() ? 'bg-ink' : 'bg-sky-400';
  }
}
