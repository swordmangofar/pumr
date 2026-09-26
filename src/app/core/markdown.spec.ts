import { MarkdownBlock, MarkdownNode, parseMarkdown } from './markdown';

function text(text: string): MarkdownNode {
  return { kind: 'text', text };
}

function only(source: string): MarkdownBlock {
  const blocks = parseMarkdown(source);
  expect(blocks).toHaveLength(1);
  return blocks[0];
}

function nodes(source: string): MarkdownNode[] {
  const block = only(source);
  if (block.kind !== 'paragraph') {
    throw new Error(`expected a paragraph, got ${block.kind}`);
  }
  return block.nodes;
}

describe('parseMarkdown', () => {
  it('parses a status reply with a table, inline code and bare URLs', () => {
    const blocks = parseMarkdown(
      [
        'The app is up and healthy:',
        '',
        '| Service | URL | Status |',
        '|---|:---:|---:|',
        '| Backend API | http://localhost:3000 | `{"status":"ok"}` |',
        '',
        '**Open http://localhost:4200.** Both built clean.',
      ].join('\n'),
    );

    expect(blocks).toEqual([
      { kind: 'paragraph', nodes: [text('The app is up and healthy:')] },
      {
        kind: 'table',
        header: [
          { align: null, nodes: [text('Service')] },
          { align: 'center', nodes: [text('URL')] },
          { align: 'right', nodes: [text('Status')] },
        ],
        rows: [
          [
            { align: null, nodes: [text('Backend API')] },
            {
              align: 'center',
              nodes: [
                {
                  kind: 'link',
                  href: 'http://localhost:3000',
                  title: 'http://localhost:3000',
                  children: [text('http://localhost:3000')],
                },
              ],
            },
            { align: 'right', nodes: [{ kind: 'code', text: '{"status":"ok"}' }] },
          ],
        ],
      },
      {
        kind: 'paragraph',
        nodes: [
          {
            kind: 'strong',
            children: [
              text('Open '),
              {
                kind: 'link',
                href: 'http://localhost:4200',
                title: 'http://localhost:4200',
                children: [text('http://localhost:4200')],
              },
              text('.'),
            ],
          },
          text(' Both built clean.'),
        ],
      },
    ]);
  });

  it('keeps single newlines as line breaks', () => {
    expect(nodes('Status: ok\nVersion: 1')).toEqual([
      text('Status: ok'),
      { kind: 'break' },
      text('Version: 1'),
    ]);
  });

  it('parses emphasis, strikethrough and headings', () => {
    expect(nodes('*a* _b_ ~~c~~ snake_case_name')).toEqual([
      { kind: 'em', children: [text('a')] },
      text(' '),
      { kind: 'em', children: [text('b')] },
      text(' '),
      { kind: 'del', children: [text('c')] },
      text(' snake_case_name'),
    ]);
    expect(only('### Next `steps`')).toEqual({
      kind: 'heading',
      level: 3,
      nodes: [text('Next '), { kind: 'code', text: 'steps' }],
    });
  });

  it('parses nested, ordered and task lists', () => {
    expect(only('3. three\n4. four\n   - nested')).toEqual({
      kind: 'list',
      ordered: true,
      start: 3,
      items: [
        { checked: null, blocks: [{ kind: 'plain', nodes: [text('three')] }] },
        {
          checked: null,
          blocks: [
            { kind: 'plain', nodes: [text('four')] },
            {
              kind: 'list',
              ordered: false,
              start: 1,
              items: [{ checked: null, blocks: [{ kind: 'plain', nodes: [text('nested')] }] }],
            },
          ],
        },
      ],
    });
    expect(only('- [x] done\n- [ ] open')).toEqual({
      kind: 'list',
      ordered: false,
      start: 1,
      items: [
        { checked: true, blocks: [{ kind: 'plain', nodes: [text('done')] }] },
        { checked: false, blocks: [{ kind: 'plain', nodes: [text('open')] }] },
      ],
    });
  });

  it('drops the task marker from loose task items too', () => {
    expect(only('- [x] done\n\n- [ ] open')).toMatchObject({
      items: [
        { checked: true, blocks: [{ kind: 'paragraph', nodes: [text('done')] }] },
        { checked: false, blocks: [{ kind: 'paragraph', nodes: [text('open')] }] },
      ],
    });
  });

  it('parses code blocks, keeping only the language from the info string', () => {
    expect(only('```ts title="a.ts"\nconst a = 1 < 2;\n```')).toEqual({
      kind: 'code',
      lang: 'ts',
      text: 'const a = 1 < 2;',
    });
    expect(only('    indented')).toEqual({ kind: 'code', lang: '', text: 'indented' });
  });

  it('renders a fence that is still streaming as code', () => {
    expect(only('```rust\nfn main() {')).toEqual({
      kind: 'code',
      lang: 'rust',
      text: 'fn main() {',
    });
  });

  it('parses quotes and rules', () => {
    expect(parseMarkdown('> quoted **bold**\n\n---')).toEqual([
      {
        kind: 'quote',
        blocks: [
          {
            kind: 'paragraph',
            nodes: [text('quoted '), { kind: 'strong', children: [text('bold')] }],
          },
        ],
      },
      { kind: 'rule' },
    ]);
  });

  it('only makes http(s) links openable', () => {
    expect(nodes('[docs](https://example.com/a) [x](javascript:alert(1)) [f](src/app.ts)')).toEqual(
      [
        {
          kind: 'link',
          href: 'https://example.com/a',
          title: 'https://example.com/a',
          children: [text('docs')],
        },
        text(' '),
        { kind: 'link', href: null, title: 'javascript:alert(1)', children: [text('x')] },
        text(' '),
        { kind: 'link', href: null, title: 'src/app.ts', children: [text('f')] },
      ],
    );
    expect(nodes('mail me@example.com')).toEqual([
      text('mail '),
      {
        kind: 'link',
        href: null,
        title: 'mailto:me@example.com',
        children: [text('me@example.com')],
      },
    ]);
  });

  it('shows images as links instead of loading them', () => {
    expect(nodes('![chart](https://example.com/c.png) ![](https://example.com/d.png)')).toEqual([
      {
        kind: 'link',
        href: 'https://example.com/c.png',
        title: 'https://example.com/c.png',
        children: [text('chart')],
      },
      text(' '),
      {
        kind: 'link',
        href: 'https://example.com/d.png',
        title: 'https://example.com/d.png',
        children: [text('https://example.com/d.png')],
      },
    ]);
  });

  it('shows raw HTML as text, except line breaks and comments', () => {
    expect(nodes('a <img src=x onerror=alert(1)> b<br>c <!-- hidden -->')).toEqual([
      text('a <img src=x onerror=alert(1)> b'),
      { kind: 'break' },
      text('c '),
    ]);
    expect(parseMarkdown('<div align="center">\n  <b>x</b>\n</div>\n\n<!-- note -->')).toEqual([
      {
        kind: 'paragraph',
        nodes: [
          text('<div align="center">'),
          { kind: 'break' },
          text('  <b>x</b>'),
          { kind: 'break' },
          text('</div>'),
        ],
      },
    ]);
  });

  it('resolves character references in text but not in code', () => {
    expect(nodes('a&nbsp;&lt;b&gt; &copy; &unknown; \\* `&lt;`')).toEqual([
      text('a <b> © &unknown; * '),
      { kind: 'code', text: '&lt;' },
    ]);
  });

  it('returns nothing for empty content', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});
