import { Injectable } from '@angular/core';
import { Mention, MentionKind, TextBlock } from '../core/models';

export interface MentionQuery {
  node: Text;
  start: number;
  end: number;
  kindPrefix: string;
  hasColon: boolean;
  term: string;
}

/**
 * DOM building blocks for the composer's contenteditable editor: pills, text
 * blocks, caret insertion and serialization. Kept out of the component so the
 * editor mechanics can be reasoned about (and tested) independently of the
 * composer's state and template.
 */
@Injectable()
export class ComposerEditorService {
  serialize(editor: HTMLElement, textBlocks: TextBlock[]): { content: string; mentions: Mention[] } {
    const mentions: Mention[] = [];
    let text = '';
    const walk = (node: Node): void => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          text += child.textContent ?? '';
          return;
        }
        if (!(child instanceof HTMLElement)) {
          return;
        }
        if (child.dataset['mention']) {
          const kind = child.dataset['kind'] as MentionKind;
          const value = child.dataset['value'] ?? '';
          const label = child.dataset['label'] ?? value;
          if (kind && !mentions.some((entry) => entry.kind === kind && entry.value === value)) {
            mentions.push({ kind, value, label });
          }
          text += ' ';
          return;
        }
        if (child.dataset['textBlock']) {
          const id = child.dataset['textBlockId'] ?? '';
          const block = textBlocks.find((entry) => entry.id === id);
          if (block) {
            text += ` ${block.text} `;
          }
          return;
        }
        if (child.tagName === 'BR') {
          text += '\n';
          return;
        }
        walk(child);
        if (child.tagName === 'DIV' || child.tagName === 'P') {
          text += '\n';
        }
      });
    };
    walk(editor);
    const content = text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { content, mentions };
  }

  detectQuery(): MentionQuery | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return null;
    }
    const node = selection.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      return null;
    }
    const text = node.textContent ?? '';
    const offset = selection.anchorOffset;
    const before = text.slice(0, offset);
    const match = /(?:^|\s)@([A-Za-z]*)(?::([^\s]*))?$/.exec(before);
    if (!match) {
      return null;
    }
    const token = match[0].replace(/^\s/, '');
    return {
      node: node as Text,
      start: offset - token.length,
      end: offset,
      kindPrefix: (match[1] ?? '').toLowerCase(),
      hasColon: match[2] !== undefined,
      term: match[2] ?? '',
    };
  }

  createPill(
    mention: Mention,
    iconPath: string,
    removeLabel: string,
    onRemove: (pill: HTMLSpanElement) => void,
  ): HTMLSpanElement {
    const pill = document.createElement('span');
    pill.className = 'mention-pill';
    pill.contentEditable = 'false';
    pill.dataset['mention'] = 'true';
    pill.dataset['kind'] = mention.kind;
    pill.dataset['value'] = mention.value;
    pill.dataset['label'] = mention.label;

    const icon = svgIcon(12, 'mention-pill-icon', iconPath, '1.5');

    const kind = document.createElement('span');
    kind.className = 'mention-pill-kind';
    kind.textContent = mention.kind;

    const label = document.createElement('span');
    label.className = 'mention-pill-label';
    label.textContent = mention.label;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mention-pill-remove';
    remove.tabIndex = -1;
    remove.setAttribute('aria-label', removeLabel);
    remove.textContent = '\u00d7';
    remove.addEventListener('mousedown', (event) => event.preventDefault());
    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove(pill);
    });

    pill.append(icon, kind, label, remove);
    return pill;
  }

  insertPill(
    editor: HTMLElement,
    query: MentionQuery | null,
    pill: HTMLSpanElement,
    onInput: () => void,
  ): void {
    const selection = window.getSelection();

    if (query) {
      const text = query.node.textContent ?? '';
      const before = text.slice(0, query.start);
      const after = text.slice(query.end);
      const beforeNode = document.createTextNode(before);
      const afterNode = document.createTextNode(after);
      const parent = query.node.parentNode;
      if (!parent) {
        return;
      }
      parent.replaceChild(afterNode, query.node);
      parent.insertBefore(beforeNode, afterNode);
      const position = document.createRange();
      position.setStart(beforeNode, before.length);
      position.collapse(true);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(position);
      }
    }

    const position =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : document.createRange();
    const fragment = document.createDocumentFragment();
    const space = document.createTextNode(' ');
    fragment.append(pill, space);
    position.insertNode(fragment);

    const caret = document.createRange();
    caret.setStart(space, space.length);
    caret.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(caret);
    }

    editor.focus();
    onInput();
  }

  createTextBlockPill(
    block: TextBlock,
    label: string,
    removeLabel: string,
    onEdit: (id: string) => void,
    onRemove: (id: string, pill: HTMLSpanElement) => void,
  ): HTMLSpanElement {
    const pill = document.createElement('span');
    pill.className = 'text-block-pill';
    pill.contentEditable = 'false';
    pill.dataset['textBlock'] = 'true';
    pill.dataset['textBlockId'] = block.id;
    pill.title = block.text.slice(0, 200);
    pill.addEventListener('mousedown', (event) => event.preventDefault());
    pill.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('.text-block-pill-remove')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onEdit(block.id);
    });

    const icon = svgIcon(
      14,
      'text-block-pill-icon',
      'M6 3.5h5.5L15 7v9.5H6zM11.5 3.5V7H15M8 10h5M8 12.5h5M8 15h3',
      '1.4',
    );

    const text = document.createElement('span');
    text.className = 'text-block-pill-label';
    text.textContent = label;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-block-pill-remove';
    remove.tabIndex = -1;
    remove.setAttribute('aria-label', removeLabel);
    remove.textContent = '\u00d7';
    remove.addEventListener('mousedown', (event) => event.preventDefault());
    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove(block.id, pill);
    });

    pill.append(icon, text, remove);
    return pill;
  }

  insertTextBlockPill(
    editor: HTMLElement,
    pill: HTMLSpanElement,
    onInput: () => void,
  ): void {
    const selection = window.getSelection();
    let range: Range | null =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || !editor.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    const fragment = document.createDocumentFragment();
    const space = document.createTextNode(' ');
    fragment.append(pill, space);
    range.insertNode(fragment);

    const caret = document.createRange();
    caret.setStart(space, space.length);
    caret.collapse(true);
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(caret);
    }
    editor.focus();
    onInput();
  }

  insertAtCaret(editor: HTMLElement, node: Node): void {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    editor.appendChild(node);
  }

  replaceQuery(text: string, query: MentionQuery, onDone: () => void): void {
    const value = query.node.textContent ?? '';
    const before = value.slice(0, query.start);
    const after = value.slice(query.end);
    query.node.textContent = before + text + after;
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      const caret = before.length + text.length;
      range.setStart(query.node, caret);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    onDone();
  }

  removePill(pill: HTMLElement, onDone: () => void): void {
    const next = pill.nextSibling;
    pill.remove();
    if (next && next.nodeType === Node.TEXT_NODE && next.textContent === ' ') {
      next.remove();
    }
    onDone();
  }
}

function svgIcon(size: number, className: string, path: string, strokeWidth: string): SVGSVGElement {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 20 20');
  icon.setAttribute('width', String(size));
  icon.setAttribute('height', String(size));
  icon.setAttribute('fill', 'none');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('class', className);
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  shape.setAttribute('stroke', 'currentColor');
  shape.setAttribute('stroke-width', strokeWidth);
  shape.setAttribute('stroke-linecap', 'round');
  shape.setAttribute('stroke-linejoin', 'round');
  icon.appendChild(shape);
  return icon;
}
