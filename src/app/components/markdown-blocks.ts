import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MarkdownBlock, MarkdownLive } from '../core/markdown';
import { MarkdownCode } from './markdown-code';
import { MarkdownInline } from './markdown-inline';

@Component({
  selector: 'app-markdown-blocks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MarkdownCode, MarkdownInline],
  host: { class: 'markdown-flow' },
  template: `
    @for (block of blocks(); track $index; let lastBlock = $last) {
      @switch (block.kind) {
        @case ('paragraph') {
          <p><app-markdown-inline [nodes]="block.nodes" [live]="lastBlock ? live() : null" /></p>
        }
        @case ('plain') {
          <div>
            <app-markdown-inline [nodes]="block.nodes" [live]="lastBlock ? live() : null" />
          </div>
        }
        @case ('heading') {
          @switch (block.level) {
            @case (1) {
              <h1>
                <app-markdown-inline [nodes]="block.nodes" [live]="lastBlock ? live() : null" />
              </h1>
            }
            @case (2) {
              <h2>
                <app-markdown-inline [nodes]="block.nodes" [live]="lastBlock ? live() : null" />
              </h2>
            }
            @case (3) {
              <h3>
                <app-markdown-inline [nodes]="block.nodes" [live]="lastBlock ? live() : null" />
              </h3>
            }
            @case (4) {
              <h4>
                <app-markdown-inline [nodes]="block.nodes" [live]="lastBlock ? live() : null" />
              </h4>
            }
            @case (5) {
              <h5>
                <app-markdown-inline [nodes]="block.nodes" [live]="lastBlock ? live() : null" />
              </h5>
            }
            @default {
              <h6>
                <app-markdown-inline [nodes]="block.nodes" [live]="lastBlock ? live() : null" />
              </h6>
            }
          }
        }
        @case ('code') {
          <app-markdown-code
            [lang]="block.lang"
            [text]="block.text"
            [live]="lastBlock ? live() : null"
          />
        }
        @case ('quote') {
          <blockquote>
            <app-markdown-blocks [blocks]="block.blocks" [live]="lastBlock ? live() : null" />
          </blockquote>
        }
        @case ('list') {
          @if (block.ordered) {
            <ol [attr.start]="block.start === 1 ? null : block.start">
              @for (item of block.items; track $index) {
                <li [class.markdown-task]="item.checked !== null">
                  @if (item.checked !== null) {
                    <input type="checkbox" disabled [checked]="item.checked" />
                  }
                  <app-markdown-blocks
                    [blocks]="item.blocks"
                    [live]="lastBlock && $last ? live() : null"
                  />
                </li>
              }
            </ol>
          } @else {
            <ul>
              @for (item of block.items; track $index) {
                <li [class.markdown-task]="item.checked !== null">
                  @if (item.checked !== null) {
                    <input type="checkbox" disabled [checked]="item.checked" />
                  }
                  <app-markdown-blocks
                    [blocks]="item.blocks"
                    [live]="lastBlock && $last ? live() : null"
                  />
                </li>
              }
            </ul>
          }
        }
        @case ('table') {
          <div class="markdown-table">
            <table>
              <thead>
                <tr>
                  @for (cell of block.header; track $index) {
                    <th [style.text-align]="cell.align">
                      <app-markdown-inline [nodes]="cell.nodes" />
                    </th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (row of block.rows; track $index; let lastRow = $last) {
                  <tr>
                    @for (cell of row; track $index) {
                      <td [style.text-align]="cell.align">
                        <app-markdown-inline
                          [nodes]="cell.nodes"
                          [live]="lastBlock && lastRow && $last ? live() : null"
                        />
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @case ('rule') {
          <hr />
        }
      }
    }
  `,
})
export class MarkdownBlocks {
  readonly blocks = input.required<MarkdownBlock[]>();

  /** Set while text streams into the last of these blocks. */
  readonly live = input<MarkdownLive>(null);
}
