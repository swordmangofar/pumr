import { Mention, TextBlock } from '../core/models';
import { ComposerEditorService } from './composer-editor.service';

describe('ComposerEditorService', () => {
  let service: ComposerEditorService;
  let editor: HTMLDivElement;

  beforeEach(() => {
    service = new ComposerEditorService();
    editor = document.createElement('div');
    editor.contentEditable = 'true';
    document.body.appendChild(editor);
  });

  afterEach(() => editor.remove());

  function caretAt(node: Node, offset: number): void {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** Types at the caret the way the browser inserts a character. */
  function type(text: string): void {
    service.insertAtCaret(editor, document.createTextNode(text));
  }

  describe('insertLineBreak', () => {
    it('keeps text typed after a trailing line break on the new line', () => {
      editor.textContent = 'first line';
      caretAt(editor.firstChild!, 'first line'.length);

      service.insertLineBreak(editor);
      expect(editor.innerHTML).toBe('first line<br><br>');

      type('second line');
      expect(service.serialize(editor, []).content).toBe('first line\nsecond line');
    });

    it('sets the caret once the new line can hold it', () => {
      editor.textContent = 'first line';
      caretAt(editor.firstChild!, 'first line'.length);
      // WebKit decides where typing goes when the caret is set and does not
      // revisit that when the placeholder follows, so a caret set before the
      // placeholder exists leaves the next typed text on the previous line.
      const selection = window.getSelection()!;
      const addRange = selection.addRange.bind(selection);
      const editorWhenSet: string[] = [];
      const spy = vi.spyOn(selection, 'addRange').mockImplementation((range) => {
        editorWhenSet.push(editor.innerHTML);
        addRange(range);
      });

      service.insertLineBreak(editor);
      spy.mockRestore();

      const placeholder = editor.querySelectorAll('br')[1];
      expect(editorWhenSet.at(-1)).toBe('first line<br><br>');
      expect(selection.isCollapsed).toBe(true);
      expect(selection.anchorNode).toBe(editor);
      expect(editor.childNodes[selection.anchorOffset]).toBe(placeholder);
    });

    it('does not add a placeholder when breaking in the middle of text', () => {
      editor.textContent = 'firstsecond';
      caretAt(editor.firstChild!, 'first'.length);

      service.insertLineBreak(editor);

      expect(editor.innerHTML).toBe('first<br>second');
      expect(service.serialize(editor, []).content).toBe('first\nsecond');
    });

    it('opens a line in an empty editor', () => {
      caretAt(editor, 0);
      service.insertLineBreak(editor);
      type('hello');
      expect(service.serialize(editor, []).content).toBe('hello');
      expect(editor.innerHTML).toBe('<br>hello<br>');
    });

    it('ignores empty text nodes after the caret', () => {
      editor.append('end', document.createTextNode(''));
      caretAt(editor.firstChild!, 3);
      service.insertLineBreak(editor);
      expect(editor.querySelectorAll('br')).toHaveLength(2);
    });

    it('appends at the end when the caret is outside the editor', () => {
      editor.textContent = 'text';
      window.getSelection()!.removeAllRanges();
      service.insertLineBreak(editor);
      expect(editor.innerHTML).toBe('text<br><br>');
    });
  });

  const CODE = 'def f():\n    if x:\n        return 1';
  const APP: Mention = { kind: 'file', value: 'src/my app/app.ts', label: 'app.ts' };

  function mentionPill(mention: Mention = APP): HTMLSpanElement {
    return service.createPill(mention, 'M0 0', 'remove', () => {});
  }

  function blockPill(block: TextBlock): HTMLSpanElement {
    return service.createTextBlockPill(
      block,
      'pasted',
      'remove',
      () => {},
      () => {},
    );
  }

  describe('serialize', () => {
    it('trims the placeholder and the blank lines in front, and keeps the ones in between', () => {
      editor.innerHTML = '<br> <br>a<br><br><br><br>b<br><br>';
      expect(service.serialize(editor, []).content).toBe('a\n\n\n\nb');
    });

    it('turns mention pills into mentions and text blocks into their text', () => {
      editor.innerHTML =
        'see <span data-mention="1" data-kind="file" data-value="src/app.ts" data-label="app.ts">app.ts</span>' +
        'and <span data-text-block="1" data-text-block-id="b1">pasted</span> please';

      const { content, mentions } = service.serialize(editor, [{ id: 'b1', text: 'LONG TEXT' }]);

      expect(content).toBe('see and LONG TEXT please');
      expect(mentions).toEqual([{ kind: 'file', value: 'src/app.ts', label: 'app.ts' }]);
    });

    it('keeps the indentation of code typed or pasted into the editor', () => {
      editor.textContent = `fix this:\n${CODE}`;
      expect(service.serialize(editor, []).content).toBe(`fix this:\n${CODE}`);

      // Line by line, with a tab and with the non-breaking spaces a browser types.
      editor.innerHTML = 'def f():<br>\u00a0 \u00a0 if x:<br>\t\treturn 1';
      expect(service.serialize(editor, []).content).toBe('def f():\n    if x:\n\t\treturn 1');
    });

    it('keeps the indentation of the first line, spaces in a line and spaces at its end', () => {
      editor.textContent = '    if x:  \n        return  1  # two\n';
      expect(service.serialize(editor, []).content).toBe('    if x:  \n        return  1  # two');
    });

    it('sends the text of a block as it was pasted', () => {
      const block = { id: 'b1', text: `    if x:  \n\n\n        return 1\n` };
      editor.append('look at ', blockPill(block), ' ', 'please');
      expect(service.serialize(editor, [block]).content).toBe(
        'look at     if x:  \n\n\n        return 1\nplease',
      );

      // Nothing in front of it: its own indentation is all there is.
      editor.replaceChildren(blockPill(block), ' ');
      expect(service.serialize(editor, [block]).content).toBe('    if x:  \n\n\n        return 1');
    });

    it('takes no more than its own space from the code around a pill', () => {
      editor.append('compare ', mentionPill(), ` with:\n${CODE}`);
      expect(service.serialize(editor, []).content).toBe(`compare with:\n${CODE}`);

      // Typed without a space on either side, the pill still parts the words.
      editor.replaceChildren('compare', mentionPill(), 'with');
      expect(service.serialize(editor, []).content).toBe('compare with');

      // At the start of an indented line and at the end of a line it leaves nothing.
      editor.replaceChildren('see\n    ', mentionPill(), ' x = 1\nand ', mentionPill(), ' ');
      editor.append(document.createElement('br'), '    y = 2');
      expect(service.serialize(editor, []).content).toBe('see\n    x = 1\nand\n    y = 2');

      editor.replaceChildren(mentionPill(), ' ', mentionPill({ ...APP, value: 'b.ts' }), ' go');
      expect(service.serialize(editor, []).content).toBe('go');
    });
  });

  describe('restore', () => {
    function restore(saved: string): TextBlock[] {
      const blocks: TextBlock[] = [];
      service.restore(editor, saved, (pill) => {
        if ('mention' in pill) {
          return mentionPill(pill.mention);
        }
        blocks.push({ id: `b${blocks.length}`, text: pill.block });
        return blockPill(blocks[blocks.length - 1]);
      });
      return blocks;
    }

    it('brings back the text and every pill of a saved editor', () => {
      const block = { id: 'pasted', text: CODE };
      editor.append('explain ', mentionPill(), ' and\n    ', blockPill(block), ' ');
      const before = service.serialize(editor, [block]);

      const blocks = restore(before.saved);

      expect(editor.querySelectorAll('[data-mention]')).toHaveLength(1);
      expect(editor.querySelectorAll('[data-text-block]')).toHaveLength(1);
      expect(blocks.map((entry) => entry.text)).toEqual([CODE]);
      // The pill that ends the editor has its space again, for the caret.
      expect(editor.lastChild?.textContent).toBe(' ');
      const after = service.serialize(editor, blocks);
      expect(after).toEqual(before);
      expect(after.mentions).toEqual([APP]);
      expect(after.content).toBe(`explain and\n    ${CODE}`);
    });

    it('loads a draft saved as plain text, whatever it holds', () => {
      const text = 'see @file:src/app.ts\n    and {"mention":1} \ufdd0nothing\ufdd1 here';
      restore(text);
      expect(editor.children).toHaveLength(0);
      expect(editor.textContent).toBe(text);

      restore('');
      expect(editor.childNodes).toHaveLength(0);
    });
  });

  describe('removePill', () => {
    it('takes the space the pill was inserted with along, also once text follows it', () => {
      const pill = mentionPill();
      editor.append('see ', pill, ' and more');
      service.removePill(pill, () => {});
      expect(service.serialize(editor, []).content).toBe('see and more');

      const last = mentionPill();
      editor.replaceChildren('see', last, ' ');
      service.removePill(last, () => {});
      expect(editor.childNodes).toHaveLength(1);
    });
  });
});
