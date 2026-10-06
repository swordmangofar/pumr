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

/** A pill as a saved draft holds it: a mention, or the text of a pasted block. */
export type SavedPill = { mention: Mention } | { block: string };

/**
 * A pill in a saved draft is its JSON between two code points that Unicode
 * keeps free for a program's own use, so no typed or pasted text holds them.
 * Tokens like `@file:path` would not do: a path may contain spaces, and a
 * pill's label is not always its value.
 */
const PILL_START = '\ufdd0';
const PILL_END = '\ufdd1';
const SAVED_PILL_RE = /\ufdd0([^\ufdd0\ufdd1]*)\ufdd1/g;

/**
 * Removes the blank lines before a message and the whitespace after it. The
 * indentation of its first line stays: pasted code needs it.
 */
export function trimEdges(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

/** Text as it leaves the editor: a browser's non-breaking spaces are spaces. */
function plain(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/[\ufdd0\ufdd1]/g, '');
}

function savePill(pill: SavedPill): string {
  return PILL_START + JSON.stringify(pill) + PILL_END;
}

function readPill(json: string): SavedPill | null {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const { mention, block } = value as { mention?: Partial<Mention> | null; block?: unknown };
    if (typeof block === 'string') {
      return { block };
    }
    if (
      mention &&
      typeof mention.kind === 'string' &&
      typeof mention.value === 'string' &&
      typeof mention.label === 'string'
    ) {
      return { mention: { kind: mention.kind, value: mention.value, label: mention.label } };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * DOM building blocks for the composer's contenteditable editor: pills, text
 * blocks, caret insertion and serialization. Kept out of the component so the
 * editor mechanics can be reasoned about (and tested) independently of the
 * composer's state and template.
 */
@Injectable()
export class ComposerEditorService {
  /**
   * Reads the editor three ways. `content` is the message: text exactly as it
   * was typed or pasted, indentation and blank lines included, with a pasted
   * block in place of its pill and one space where a mention pill stood.
   * `mentions` are those pills, and `saved` is what `restore` needs to bring
   * the same editor back, pills included.
   */
  serialize(
    editor: HTMLElement,
    textBlocks: TextBlock[],
  ): { content: string; mentions: Mention[]; saved: string } {
    const mentions: Mention[] = [];
    let content = '';
    let saved = '';
    // A pill stands between `content` and whatever comes next.
    let gap = false;
    // `content` ends in text of the editor itself, not in the text of a block.
    let typed = false;
    // A pill is set off by one space. The space it was inserted with, or one
    // typed beside it, is that space; every other space stays as typed, and a
    // pill at the start or the end of a line leaves nothing behind.
    const openGap = (): void => {
      if (!gap && typed && (content.endsWith(' ') || content.endsWith('\t'))) {
        content = content.slice(0, -1);
      }
      gap = true;
    };
    const add = (chunk: string, fromEditor: boolean): void => {
      const text = gap && fromEditor ? chunk.replace(/^[ \t]/, '') : chunk;
      if (text === '') {
        return;
      }
      if (gap) {
        const lineEdge = content === '' || content.endsWith('\n') || text.startsWith('\n');
        content += lineEdge ? text : ` ${text}`;
        gap = false;
      } else {
        content += text;
      }
      typed = fromEditor;
    };
    const type = (chunk: string): void => {
      add(chunk, true);
      saved += chunk;
    };
    const walk = (node: Node): void => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          type(plain(child.textContent ?? ''));
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
          openGap();
          if (kind) {
            saved += savePill({ mention: { kind, value, label } });
          }
          return;
        }
        if (child.dataset['textBlock']) {
          const id = child.dataset['textBlockId'] ?? '';
          const block = textBlocks.find((entry) => entry.id === id);
          if (block) {
            const text = plain(block.text);
            openGap();
            add(text, false);
            openGap();
            saved += savePill({ block: text });
          }
          return;
        }
        if (child.tagName === 'BR') {
          type('\n');
          return;
        }
        walk(child);
        if (child.tagName === 'DIV' || child.tagName === 'P') {
          type('\n');
        }
      });
    };
    walk(editor);
    return { content: trimEdges(content), mentions, saved: trimEdges(saved) };
  }

  /**
   * Fills the editor from what `serialize` saved of it: the text as it was
   * typed and every pill where it stood, built by `createPill`. A draft saved
   * before pills were kept is plain text and comes back as that.
   */
  restore(editor: HTMLElement, saved: string, createPill: (pill: SavedPill) => HTMLElement): void {
    const nodes: Node[] = [];
    let end = 0;
    for (const match of saved.matchAll(SAVED_PILL_RE)) {
      const pill = readPill(match[1]);
      if (!pill) {
        continue;
      }
      if (match.index > end) {
        nodes.push(document.createTextNode(saved.slice(end, match.index)));
      }
      nodes.push(createPill(pill));
      end = match.index + match[0].length;
    }
    if (end < saved.length) {
      nodes.push(document.createTextNode(saved.slice(end)));
    } else if (nodes.length > 0) {
      // The space a pill is inserted with: the caret needs text to stand in.
      nodes.push(document.createTextNode(' '));
    }
    editor.textContent = '';
    editor.append(...nodes);
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

  /**
   * Inserts a line break at the caret. A `<br>` that ends the editor is not
   * rendered as a line of its own and the browser moves the caret back in
   * front of it, so the next typed text would join the previous line. A
   * trailing placeholder `<br>` keeps the new line open; `serialize` trims it.
   */
  insertLineBreak(editor: HTMLElement): void {
    const lineBreak = document.createElement('br');
    this.insertAtCaret(editor, lineBreak);
    if (!this.endsEditor(lineBreak, editor)) {
      return;
    }
    const placeholder = document.createElement('br');
    lineBreak.after(placeholder);
    // WebKit settles where typing goes at the moment the caret is set. That was
    // before the placeholder existed, so it had already moved the caret in
    // front of `lineBreak`; the selection it reports still reads as if it were
    // behind it. Setting the caret again now puts it on the new line.
    const selection = window.getSelection();
    if (selection && editor.contains(selection.anchorNode)) {
      const caret = document.createRange();
      caret.setStartBefore(placeholder);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
    }
  }

  private endsEditor(node: Node, editor: HTMLElement): boolean {
    for (
      let current: Node | null = node;
      current && current !== editor;
      current = current.parentNode
    ) {
      for (let next = current.nextSibling; next; next = next.nextSibling) {
        if (next.nodeType !== Node.TEXT_NODE || next.textContent) {
          return false;
        }
      }
    }
    return true;
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

  /**
   * Removes a pill together with the space it was inserted with, also once
   * text was typed behind that space: nothing collapses two spaces later on.
   */
  removePill(pill: HTMLElement, onDone: () => void): void {
    const next = pill.nextSibling;
    pill.remove();
    if (next instanceof Text && next.data === ' ') {
      next.remove();
    } else if (next instanceof Text && next.data.startsWith(' ')) {
      next.deleteData(0, 1);
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
