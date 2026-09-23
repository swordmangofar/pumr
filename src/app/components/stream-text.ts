import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  linkedSignal,
} from '@angular/core';

interface StreamChunk {
  id: number;
  text: string;
}

interface StreamState {
  full: string;
  settled: string;
  recent: StreamChunk[];
  nextId: number;
}

const MAX_RECENT = 32;

/** Distance from the bottom (px) within which the view is considered pinned. */
const STICK_THRESHOLD = 24;

@Component({
  selector: 'app-stream-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span>{{ settled() }}</span>
    @for (chunk of recent(); track chunk.id) {
      <span class="stream-chunk">{{ chunk.text }}</span>
    }
  `,
})
export class StreamText {
  readonly content = input('');

  /**
   * When true, the nearest scrollable ancestor (e.g. the collapsible "thinking"
   * panel body) is kept pinned to the bottom as text streams in. Left off for
   * plain message content, whose scrolling is owned by the chat view.
   */
  readonly follow = input(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Nearest scrollable ancestor, e.g. the collapsible "thinking" panel body. */
  private scroller: HTMLElement | null = null;
  private pinned = true;
  private queued = false;

  private readonly state = linkedSignal<string, StreamState>({
    source: this.content,
    computation: (content, previous) => {
      const prev = previous?.value;
      if (!prev || !content.startsWith(prev.full)) {
        return { full: content, settled: content, recent: [], nextId: 0 };
      }
      const delta = content.slice(prev.full.length);
      if (!delta) {
        return prev;
      }
      const recent = [...prev.recent, { id: prev.nextId, text: delta }];
      let settled = prev.settled;
      if (recent.length > MAX_RECENT) {
        const overflow = recent.splice(0, recent.length - MAX_RECENT);
        settled += overflow.map((chunk) => chunk.text).join('');
      }
      return { full: content, settled, recent, nextId: prev.nextId + 1 };
    },
  });

  protected readonly settled = computed(() => this.state().settled);
  protected readonly recent = computed(() => this.state().recent);

  private readonly onScroll = (): void => {
    if (this.scroller) {
      this.pinned = this.isAtBottom(this.scroller);
    }
  };

  constructor() {
    const destroyRef = inject(DestroyRef);

    afterRenderEffect(() => {
      this.content();
      if (!this.follow()) {
        return;
      }
      if (!this.scroller && !this.attach()) {
        return;
      }
      this.stickToBottom();
    });

    destroyRef.onDestroy(() => {
      this.scroller?.removeEventListener('scroll', this.onScroll);
    });
  }

  /** Resolves the scroll container and starts tracking whether the user is at its bottom. */
  private attach(): boolean {
    let node = this.host.nativeElement.parentElement;
    while (node) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') {
        this.scroller = node;
        this.pinned = this.isAtBottom(node);
        node.addEventListener('scroll', this.onScroll, { passive: true });
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  private isAtBottom(element: HTMLElement): boolean {
    if (element.clientHeight === 0 || element.scrollHeight <= element.clientHeight) {
      // Hidden (collapsed panel) or not overflowing yet: nothing to follow.
      return true;
    }
    return element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD;
  }

  /** Keeps a pinned container glued to the bottom as the text streams in. */
  private stickToBottom(): void {
    if (!this.pinned || this.queued) {
      return;
    }
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      const element = this.scroller;
      if (element && this.pinned) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }
}
