import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MarkdownLive, parseMarkdown } from '../core/markdown';
import { MarkdownBlocks } from './markdown-blocks';

/** Renders agent-written markdown, see `parseMarkdown` for what is supported. */
@Component({
  selector: 'app-markdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MarkdownBlocks],
  host: { class: 'markdown block' },
  template: `<app-markdown-blocks [blocks]="blocks()" [live]="live()" />`,
})
export class MarkdownView {
  readonly content = input('');

  /** True while the text is still streaming in. */
  readonly streaming = input(false);

  /** Shows the typing caret after the text while it streams. */
  readonly caret = input(true);

  protected readonly blocks = computed(() => parseMarkdown(this.content()));
  protected readonly live = computed<MarkdownLive>(() => {
    if (!this.streaming()) {
      return null;
    }
    return this.caret() ? 'caret' : 'text';
  });
}
