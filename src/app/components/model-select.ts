import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { providerIdOf } from '../core/api';
import { ModelsService } from '../core/models.service';
import { ProvidersService } from '../core/providers.service';
import { ModelMenu } from './model-menu';
import { ProviderMark } from './provider-mark';

/** Room the menu needs below the field before it opens upwards instead. */
const MENU_ROOM = 320;
/** Space a docked menu keeps to the edge of the area that clips it. */
const MENU_GAP = 16;
/** A docked menu is never squeezed below this height. */
const MIN_MENU_HEIGHT = 160;

/** A form field that picks a model with the same menu as the composer. */
@Component({
  selector: 'app-model-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ModelMenu, ProviderMark],
  host: {
    class: 'relative block',
    '(document:pointerdown)': 'onDocumentPointerDown($event)',
    '(keydown.escape)': 'onEscape($event)',
  },
  template: `
    <button
      #trigger
      type="button"
      class="field field-select flex w-full items-center gap-2 rounded-xl py-2 pr-9 pl-4 text-left text-sm"
      aria-haspopup="listbox"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="label()"
      (click)="open() ? close() : show()"
    >
      @if (value()) {
        <app-provider-mark [provider]="providerId()" size="xs" />
        <span class="min-w-0 truncate text-white">{{ selectedModel()?.name ?? value() }}</span>
        @if (selectedModel()) {
          <span class="max-w-32 shrink-0 truncate text-xs text-mist/35">{{ providerName() }}</span>
        }
      } @else {
        <span class="truncate text-mist/40">{{ placeholder() }}</span>
      }
    </button>
    @if (open()) {
      <app-model-menu
        class="absolute left-0 z-40 max-h-[min(28rem,60vh)] w-full min-w-72"
        [class]="upwards() ? 'bottom-full mb-2' : 'top-full mt-2'"
        [style.max-height]="room() === null ? null : 'min(28rem, 60vh, ' + room() + 'px)'"
        [selected]="value()"
        [only]="only()"
        [clearLabel]="clearable() ? placeholder() : null"
        (picked)="pick($event)"
      />
    }
  `,
})
export class ModelSelect {
  private readonly modelsService = inject(ModelsService);
  private readonly providers = inject(ProvidersService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly value = input<string | null>(null);
  /** Shown while no model is chosen, and as the menu's "none" row when clearable. */
  readonly placeholder = input('');
  readonly clearable = input(false, { transform: booleanAttribute });
  readonly label = input<string | null>(null);
  /** When set, the menu lists only the models with these ids. */
  readonly only = input<readonly string[] | null>(null);
  /**
   * For a field docked at the bottom of an area that clips it, outside a
   * scrolling form: the menu opens upwards whenever there is room and is
   * never taller than the room it has.
   */
  readonly docked = input(false, { transform: booleanAttribute });
  readonly valueChange = output<string | null>();

  protected readonly open = signal(false);
  protected readonly upwards = signal(false);
  /** Height in pixels a docked menu may take; `null` leaves it to the stylesheet. */
  protected readonly room = signal<number | null>(null);
  protected readonly selectedModel = computed(() => this.modelsService.byId(this.value() ?? ''));
  protected readonly providerId = computed(() => providerIdOf(this.value() ?? ''));
  protected readonly providerName = computed(() => this.providers.name(this.providerId()));
  private readonly triggerRef = viewChild<ElementRef<HTMLButtonElement>>('trigger');

  protected show(): void {
    const rect = this.triggerRef()?.nativeElement.getBoundingClientRect();
    const docked = this.docked();
    const upwards =
      !!rect && rect.top > MENU_ROOM && (docked || window.innerHeight - rect.bottom < MENU_ROOM);
    this.upwards.set(upwards);
    this.room.set(docked && rect ? this.roomFor(rect, upwards) : null);
    this.open.set(true);
  }

  /** Pixels between the field and the edge of the area that clips the menu. */
  private roomFor(field: DOMRect, upwards: boolean): number {
    let top = 0;
    let bottom = window.innerHeight;
    for (let node = this.host.nativeElement.parentElement; node; node = node.parentElement) {
      if (getComputedStyle(node).overflowY !== 'visible') {
        ({ top, bottom } = node.getBoundingClientRect());
        break;
      }
    }
    const room = upwards ? field.top - top : bottom - field.bottom;
    return Math.max(room - MENU_GAP, MIN_MENU_HEIGHT);
  }

  protected close(): void {
    this.open.set(false);
  }

  protected pick(modelId: string | null): void {
    this.valueChange.emit(modelId);
    this.close();
    this.triggerRef()?.nativeElement.focus();
  }

  protected onDocumentPointerDown(event: PointerEvent): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
      this.close();
    }
  }

  protected onEscape(event: Event): void {
    if (!this.open()) {
      return;
    }
    // Keep the settings dialog open; only the menu closes.
    event.stopPropagation();
    this.close();
    this.triggerRef()?.nativeElement.focus();
  }
}
