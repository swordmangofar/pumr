import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';

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
}
