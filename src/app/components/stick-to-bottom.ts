import { DestroyRef, Directive, ElementRef, afterRenderEffect, inject, input } from '@angular/core';

/** Distance from the bottom (px) within which the view is considered pinned. */
const STICK_THRESHOLD = 24;

/**
 * Keeps a scroll container glued to its bottom while the bound content grows,
 * unless the reader has scrolled up (e.g. the streaming "thinking" panel).
 */
@Directive({ selector: '[appStickToBottom]' })
export class StickToBottom {
  /** The content being followed; each change re-pins a pinned container. */
  readonly appStickToBottom = input<unknown>();

  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private pinned = true;
  private queued = false;

  constructor() {
    const onScroll = (): void => {
      this.pinned = this.isAtBottom();
    };
    this.element.addEventListener('scroll', onScroll, { passive: true });
    inject(DestroyRef).onDestroy(() => this.element.removeEventListener('scroll', onScroll));

    afterRenderEffect(() => {
      this.appStickToBottom();
      this.stick();
    });
  }

  private isAtBottom(): boolean {
    const element = this.element;
    if (element.clientHeight === 0 || element.scrollHeight <= element.clientHeight) {
      // Hidden (collapsed panel) or not overflowing yet: nothing to follow.
      return true;
    }
    return element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD;
  }

  private stick(): void {
    if (!this.pinned || this.queued) {
      return;
    }
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      if (this.pinned) {
        this.element.scrollTop = this.element.scrollHeight;
      }
    });
  }
}
