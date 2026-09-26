import { ansiToHtml, stripAnsi } from './ansi';

describe('stripAnsi', () => {
  it('removes colour codes', () => {
    expect(stripAnsi('\x1b[1;31merror\x1b[0m: done')).toBe('error: done');
  });

  it('removes OSC sequences such as hyperlinks', () => {
    expect(stripAnsi('\x1b]8;;https://example.test\x07link\x1b]8;;\x1b\\')).toBe('link');
  });

  it('leaves plain text alone', () => {
    expect(stripAnsi('a < b && c')).toBe('a < b && c');
  });
});

describe('ansiToHtml', () => {
  it('colours text and escapes markup', () => {
    const html = ansiToHtml('\x1b[31m<b>\x1b[0m');
    expect(html).toContain('color:');
    expect(html).toContain('&lt;b&gt;');
  });
});
