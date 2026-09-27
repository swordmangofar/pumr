import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { CapabilityItem, searchCapabilities } from '../core/capability-catalog.service';
import { TypedInput } from './typed-input';

/** Lists longer than this get a filter field. */
const FILTER_THRESHOLD = 8;

/**
 * Multi-select chips for skills or MCP servers. Selected entries come first;
 * a selection that no longer exists (removed or disabled) stays visible in
 * amber so it can be spotted and cleared instead of silently doing nothing.
 */
@Component({
  selector: 'app-capability-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TypedInput, TranslocoPipe],
  template: `
    <div class="mb-1 flex items-center justify-between gap-2">
      <span class="text-[10px] tracking-wide text-mist/40 uppercase">
        {{ labelKey() | transloco }}
      </span>
      @if (selected().length > 0) {
        <span class="text-[10px] text-accent/70">
          {{ 'right.selectedCount' | transloco: { count: selected().length } }}
        </span>
      }
    </div>
    @if (items().length > filterThreshold) {
      <input
        type="search"
        class="field mb-1.5 w-full rounded-lg px-2.5 py-1 text-xs"
        [value]="filter()"
        [placeholder]="'right.filterPlaceholder' | transloco"
        (typedValue)="filter.set($event)"
      />
    }
    <div class="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
      @for (name of missing(); track name) {
        <button
          type="button"
          class="rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] text-amber-300 line-through transition-colors hover:border-amber-400/70"
          [attr.title]="'right.missingCapability' | transloco"
          (click)="toggled.emit(name)"
        >
          {{ name }} ✕
        </button>
      }
      @for (item of visible(); track item.name) {
        <button
          type="button"
          class="max-w-full truncate rounded-full border px-2.5 py-1 text-[11px] transition-colors"
          [class]="
            isSelected(item.name)
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-white/10 text-mist/40 hover:text-mist'
          "
          [attr.title]="tooltip(item)"
          [attr.aria-pressed]="isSelected(item.name)"
          (click)="toggled.emit(item.name)"
        >
          {{ item.name }}
        </button>
      } @empty {
        @if (missing().length === 0) {
          <span class="text-xs text-mist/30">
            {{ (items().length > 0 ? 'composer.mentionNoResults' : emptyKey()) | transloco }}
          </span>
        }
      }
    </div>
  `,
})
export class CapabilityPicker {
  readonly items = input.required<CapabilityItem[]>();
  readonly selected = input.required<string[]>();
  readonly labelKey = input.required<string>();
  readonly emptyKey = input.required<string>();
  /** When false, selections are not flagged as missing (catalog still loading). */
  readonly loaded = input(true);
  readonly toggled = output<string>();

  protected readonly filterThreshold = FILTER_THRESHOLD;
  protected readonly filter = signal('');

  protected readonly missing = computed(() => {
    if (!this.loaded()) {
      return [];
    }
    const known = new Set(this.items().map((item) => item.name));
    return this.selected().filter((name) => !known.has(name));
  });

  protected readonly visible = computed(() => {
    const selected = new Set(this.selected());
    const matches = searchCapabilities(this.items(), this.filter());
    if (this.filter().trim()) {
      return matches;
    }
    return [
      ...matches.filter((item) => selected.has(item.name)),
      ...matches.filter((item) => !selected.has(item.name)),
    ];
  });

  protected isSelected(name: string): boolean {
    return this.selected().includes(name);
  }

  protected tooltip(item: CapabilityItem): string {
    const sources = item.sources.join(', ');
    return item.description ? `${item.description}\n${sources}` : sources;
  }
}
