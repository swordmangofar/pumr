import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { api } from '../core/api';
import { MarkdownLive, MarkdownNode } from '../core/markdown';
import { StreamText } from './stream-text';

@Component({
  selector: 'app-markdown-inline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StreamText],
  template: `
    @for (node of nodes(); track $index) {
      @switch (node.kind) {
        @case ('text') {
          @if (live()) {
            <app-stream-text [content]="node.text" />
          } @else {
            <ng-container>{{ node.text }}</ng-container>
          }
        }
        @case ('code') {
          <code>{{ node.text }}</code>
        }
        @case ('break') {
          <br />
        }
        @case ('strong') {
          <strong><app-markdown-inline [nodes]="node.children" /></strong>
        }
        @case ('em') {
          <em><app-markdown-inline [nodes]="node.children" /></em>
        }
        @case ('del') {
          <del><app-markdown-inline [nodes]="node.children" /></del>
        }
        @case ('link') {
          @if (node.href; as href) {
            <a
              role="link"
              tabindex="0"
              [attr.title]="node.title"
              (click)="open($event, href)"
              (keydown.enter)="open($event, href)"
            >
              <app-markdown-inline [nodes]="node.children" />
            </a>
          } @else {
            <span [attr.title]="node.title"><app-markdown-inline [nodes]="node.children" /></span>
          }
        }
      }
    }
    @if (live() === 'caret') {
      <span
        class="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-text-bottom"
        aria-hidden="true"
      ></span>
    }
  `,
})
export class MarkdownInline {
  readonly nodes = input.required<MarkdownNode[]>();

  /** Set on the run text is streaming into: new text fades in, optionally followed by the caret. */
  readonly live = input<MarkdownLive>(null);

  // Links carry no href, so neither a click nor the context menu can navigate
  // the app window; web links open in the system browser instead.
  protected open(event: Event, href: string): void {
    event.preventDefault();
    api.openExternalUrl(href).catch((error: unknown) => console.error(error));
  }
}
