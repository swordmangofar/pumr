import { Directive, HostListener, output } from '@angular/core';

/**
 * Replaces the pervasive `$any($event.target).value` / `.checked` template
 * casts with typed outputs. Apply to any `input`, `textarea` or `select` and
 * bind `(typedValue)` or `(typedChecked)`.
 */
@Directive({ selector: 'input, textarea, select' })
export class TypedInput {
  readonly typedValue = output<string>();
  readonly typedChecked = output<boolean>();

  @HostListener('input', ['$event.target'])
  protected onInput(target: EventTarget | null): void {
    if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
      this.typedChecked.emit(target.checked);
      return;
    }
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      this.typedValue.emit(target.value);
    }
  }
}
