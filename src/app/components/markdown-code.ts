import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { MarkdownLive } from '../core/markdown';
import { MonacoService } from '../core/monaco.service';
import { ThemeService } from '../core/theme.service';
import { CopyButton } from './copy-button';
import { StreamText } from './stream-text';

interface Highlight {
  text: string;
  lang: string;
  html: string;
}

/** A fenced code block, syntax-highlighted by Monaco once it is complete. */
@Component({
  selector: 'app-markdown-code',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CopyButton, StreamText],
  host: { class: 'block overflow-hidden rounded-xl border border-white/10 bg-ink/60' },
  template: `
    <div class="flex items-center justify-between gap-2 border-b border-white/5 py-1 pr-1.5 pl-3">
      <span class="truncate font-mono text-[11px] text-mist/40">{{ lang() }}</span>
      <app-copy-button
        [text]="text()"
        buttonClass="h-6 w-6 border-white/10 bg-white/5 text-mist/40 hover:border-accent/40 hover:bg-accent/15 hover:text-accent"
      />
    </div>
    <pre
      class="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed text-mist"
    >@if (html(); as html) {<code [innerHTML]="html"></code>} @else {<code>@if (live()) {<app-stream-text [content]="text()" />@if (live() === 'caret') {<span class="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-text-bottom" aria-hidden="true"></span>}} @else {<ng-container>{{ text() }}</ng-container>}</code>}</pre>
  `,
})
export class MarkdownCode {
  readonly lang = input('');
  readonly text = input('');
  readonly live = input<MarkdownLive>(null);

  private readonly monaco = inject(MonacoService);
  private readonly theme = inject(ThemeService);
  private readonly highlight = signal<Highlight | null>(null);
  private request = 0;

  /**
   * Monaco's markup for exactly the text shown. It is bound as plain HTML, so
   * Angular's sanitizer still checks it (it only holds token spans and breaks).
   */
  protected readonly html = computed(() => {
    const highlight = this.highlight();
    return highlight &&
      !this.live() &&
      highlight.text === this.text() &&
      highlight.lang === this.lang()
      ? highlight.html
      : null;
  });

  constructor() {
    // Monaco's token classes are specific to a theme, so a theme change
    // colorizes the block again.
    effect(() => {
      const text = this.text();
      const lang = this.lang();
      this.theme.current();
      if (this.live() || !lang) {
        return;
      }
      const request = ++this.request;
      this.monaco
        .colorizeFence(text, lang)
        .then((html) => {
          if (request === this.request) {
            this.highlight.set(html === null ? null : { text, lang, html });
          }
        })
        .catch(() => {
          // Without Monaco the block stays plain text.
        });
    });
  }
}
