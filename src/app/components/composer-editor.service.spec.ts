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

  describe('serialize', () => {
    it('trims the placeholder and collapses runs of blank lines', () => {
      editor.innerHTML = 'a<br><br><br><br>b<br><br>';
      expect(service.serialize(editor, []).content).toBe('a\n\nb');
    });

    it('turns mention pills into mentions and text blocks into their text', () => {
      editor.innerHTML =
        'see <span data-mention="1" data-kind="file" data-value="src/app.ts" data-label="app.ts">app.ts</span>' +
        'and <span data-text-block="1" data-text-block-id="b1">pasted</span> please';

      const { content, mentions } = service.serialize(editor, [{ id: 'b1', text: 'LONG TEXT' }]);

      expect(content).toBe('see and LONG TEXT please');
      expect(mentions).toEqual([{ kind: 'file', value: 'src/app.ts', label: 'app.ts' }]);
    });
  });
});
