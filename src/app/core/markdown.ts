import { Marked, MarkedToken, Token, Tokens } from 'marked';

/** Text-level markdown content, reduced to the nodes the chat renders. */
export type MarkdownNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'break' }
  | { kind: 'strong' | 'em' | 'del'; children: MarkdownNode[] }
  | {
      kind: 'link';
      /** Null when the destination is not a web link the app may open. */
      href: string | null;
      title: string;
      children: MarkdownNode[];
    };

export interface MarkdownListItem {
  /** Task-list state, or null for a regular item. */
  checked: boolean | null;
  blocks: MarkdownBlock[];
}

export interface MarkdownCell {
  align: 'left' | 'center' | 'right' | null;
  nodes: MarkdownNode[];
}

export type MarkdownBlock =
  // `plain` is inline content without paragraph spacing (tight list items).
  | { kind: 'paragraph' | 'plain'; nodes: MarkdownNode[] }
  | { kind: 'heading'; level: number; nodes: MarkdownNode[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; blocks: MarkdownBlock[] }
  | { kind: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { kind: 'table'; header: MarkdownCell[]; rows: MarkdownCell[][] }
  | { kind: 'rule' };

/**
 * How the end of a streaming text renders: `text` fades new text in, `caret`
 * also shows the typing caret after it. Null once the text is complete.
 */
export type MarkdownLive = 'text' | 'caret' | null;

// GFM for tables, strikethrough, task lists and bare URLs. Single newlines stay
// line breaks, as they were in the plain-text view.
const markdown = new Marked({ gfm: true, breaks: true });

const WEB_LINK = /^https?:\/\//i;
const BREAK_TAG = /^<br\s*\/?>$/i;
const HTML_COMMENT = /^<!--[\s\S]*-->$/;
const CHARACTER_REFERENCE = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i;

let referenceDecoder: HTMLTextAreaElement | undefined;

/**
 * Parses an agent reply into render-ready blocks. Raw HTML is kept as literal
 * text, images become links (remote images are never fetched) and only
 * http(s) links are openable.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  try {
    return toBlocks(markdown.lexer(source));
  } catch {
    // The lexer throws on input it cannot make progress on; show it verbatim.
    return [{ kind: 'paragraph', nodes: lines(source) }];
  }
}

function toBlocks(tokens: Token[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const token of tokens) {
    const block = toBlock(token as MarkedToken);
    if (block) {
      blocks.push(block);
    }
  }
  return blocks;
}

function toBlock(token: MarkedToken): MarkdownBlock | null {
  switch (token.type) {
    case 'paragraph':
      return { kind: 'paragraph', nodes: toNodes(token.tokens) };
    case 'text':
      return { kind: 'plain', nodes: token.tokens ? toNodes(token.tokens) : lines(token.text) };
    case 'heading':
      return { kind: 'heading', level: token.depth, nodes: toNodes(token.tokens) };
    case 'code':
      // The info string may carry attributes after the language (```ts title="x").
      return { kind: 'code', lang: token.lang?.trim().split(/\s+/)[0] ?? '', text: token.text };
    case 'blockquote':
      return { kind: 'quote', blocks: toBlocks(token.tokens) };
    case 'list':
      return {
        kind: 'list',
        ordered: token.ordered,
        start: typeof token.start === 'number' ? token.start : 1,
        items: token.items.map((item) => ({
          checked: item.task ? (item.checked ?? false) : null,
          blocks: toBlocks(item.tokens),
        })),
      };
    case 'table':
      return {
        kind: 'table',
        header: token.header.map(toCell),
        rows: token.rows.map((row) => row.map(toCell)),
      };
    case 'hr':
      return { kind: 'rule' };
    case 'html': {
      const html = token.text.trim();
      return HTML_COMMENT.test(html) ? null : { kind: 'paragraph', nodes: lines(html) };
    }
    case 'space':
    case 'def':
    case 'checkbox':
      return null;
    default:
      return { kind: 'paragraph', nodes: lines(token.raw) };
  }
}

function toCell(cell: Tokens.TableCell): MarkdownCell {
  return { align: cell.align, nodes: toNodes(cell.tokens) };
}

function toNodes(tokens: Token[]): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  for (const token of tokens) {
    appendNode(nodes, token as MarkedToken);
  }
  return nodes;
}

function appendNode(nodes: MarkdownNode[], token: MarkedToken): void {
  switch (token.type) {
    case 'text':
      if (token.tokens) {
        for (const child of token.tokens) {
          appendNode(nodes, child as MarkedToken);
        }
      } else {
        appendText(nodes, decodeReferences(token.text));
      }
      return;
    case 'escape':
      appendText(nodes, token.text);
      return;
    case 'codespan':
      nodes.push({ kind: 'code', text: token.text });
      return;
    case 'br':
      nodes.push({ kind: 'break' });
      return;
    case 'strong':
    case 'em':
    case 'del':
      nodes.push({ kind: token.type, children: toNodes(token.tokens) });
      return;
    case 'link':
      nodes.push({
        kind: 'link',
        href: webLink(token.href),
        title: token.href,
        // Autolink text is the literal destination, references included.
        children: token.autolink ? [{ kind: 'text', text: token.text }] : toNodes(token.tokens),
      });
      return;
    case 'image':
      nodes.push({
        kind: 'link',
        href: webLink(token.href),
        title: token.href,
        children: [{ kind: 'text', text: token.text || token.href }],
      });
      return;
    case 'html': {
      const html = token.text.trim();
      if (BREAK_TAG.test(html)) {
        nodes.push({ kind: 'break' });
      } else if (!HTML_COMMENT.test(html)) {
        appendText(nodes, token.text);
      }
      return;
    }
    case 'checkbox':
      return;
    default:
      appendText(nodes, token.raw);
  }
}

/** Adds text, merging it into a preceding text node. */
function appendText(nodes: MarkdownNode[], text: string): void {
  const last = nodes.at(-1);
  if (last?.kind === 'text') {
    last.text += text;
  } else if (text) {
    nodes.push({ kind: 'text', text });
  }
}

function lines(text: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  text.split('\n').forEach((line, index) => {
    if (index > 0) {
      nodes.push({ kind: 'break' });
    }
    appendText(nodes, line);
  });
  return nodes;
}

function webLink(href: string): string | null {
  const url = href.trim();
  return WEB_LINK.test(url) ? url : null;
}

/** Resolves named character references (`&nbsp;`, `&lt;`, …) the lexer leaves in text. */
function decodeReferences(text: string): string {
  if (!CHARACTER_REFERENCE.test(text) || typeof document === 'undefined') {
    return text;
  }
  // A textarea parses its content as RCDATA, so markup stays text; the inert
  // document keeps anything from loading even if it did not.
  referenceDecoder ??= document.implementation.createHTMLDocument('').createElement('textarea');
  referenceDecoder.innerHTML = text;
  return referenceDecoder.value;
}
