import { Pipe, PipeTransform, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { PendingQuestion, QuestionItem } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';
import { QuestionOverlay } from './question-overlay';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

function question(patch: Partial<QuestionItem> = {}): QuestionItem {
  return {
    header: 'Database',
    question: 'Which database?',
    options: [
      { label: 'Postgres', description: 'Mature and fast', recommended: true },
      { label: 'SQLite', description: null, recommended: false },
      { label: 'MySQL', description: null, recommended: false },
    ],
    multiSelect: false,
    ...patch,
  };
}

function request(questions: QuestionItem[]): PendingQuestion {
  return { kind: 'questionRequest', requestId: 'req-1', sessionId: 'session', questions };
}

describe('QuestionOverlay', () => {
  let fixture: ComponentFixture<QuestionOverlay>;
  let resolveQuestion: ReturnType<typeof vi.fn>;
  let requestComposerFocus: ReturnType<typeof vi.fn>;
  const focusedPanel = signal<string | null>(null);
  const composerFocusNonce = signal(0);

  function create(questions: QuestionItem[]): void {
    resolveQuestion = vi.fn().mockResolvedValue(undefined);
    requestComposerFocus = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WorkspaceService,
          useValue: {
            resolveQuestion,
            requestComposerFocus,
            composerFocusNonce,
            focusedPanel,
            setFocusedPanel: (panel: string | null) => focusedPanel.set(panel),
          },
        },
      ],
    });
    TestBed.overrideComponent(QuestionOverlay, {
      remove: { imports: [TranslocoPipe] },
      add: { imports: [StubTranslocoPipe] },
    });
    fixture = TestBed.createComponent(QuestionOverlay);
    fixture.componentRef.setInput('request', request(questions));
    fixture.detectChanges();
  }

  function element(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function button(text: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes(text),
    );
    if (!found) {
      throw new Error(`no button containing "${text}"`);
    }
    return found;
  }

  function click(text: string): void {
    button(text).click();
    fixture.detectChanges();
  }

  function press(key: string): void {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
  }

  it('marks only the recommended option', () => {
    create([question()]);

    const badges = element().querySelectorAll('[data-testid="recommended"]');
    expect(badges.length).toBe(1);
    expect(badges[0].textContent?.trim()).toBe('question.recommended');
    expect(button('Postgres').contains(badges[0])).toBe(true);
  });

  it('preselects the first option of a single-answer question', () => {
    create([question()]);

    expect(button('Postgres').getAttribute('aria-pressed')).toBe('true');
    expect(button('SQLite').getAttribute('aria-pressed')).toBe('false');
    click('question.submit');

    expect(resolveQuestion).toHaveBeenCalledWith('req-1', [
      expect.objectContaining({ selected: ['Postgres'], custom: null }),
    ]);
  });

  it('preselects the first option of each single-answer question', () => {
    create([
      question(),
      question({
        question: 'Which runtime?',
        options: [
          { label: 'Node', description: null, recommended: false },
          { label: 'Deno', description: null, recommended: true },
        ],
      }),
    ]);

    click('question.next');
    click('question.submit');

    expect(resolveQuestion).toHaveBeenCalledWith('req-1', [
      expect.objectContaining({ selected: ['Postgres'] }),
      expect.objectContaining({ selected: ['Node'] }),
    ]);
  });

  it('keeps the preselected option when it is pressed', () => {
    create([question()]);

    click('Postgres');

    expect(button('Postgres').getAttribute('aria-pressed')).toBe('true');
  });

  it('moves the pick of a single-answer question to the pressed option', () => {
    create([question()]);

    click('MySQL');
    click('question.submit');

    expect(resolveQuestion).toHaveBeenCalledWith('req-1', [
      expect.objectContaining({ selected: ['MySQL'] }),
    ]);
  });

  it('preselects nothing in a multi-select question', () => {
    create([question({ multiSelect: true })]);

    click('question.submit');

    expect(resolveQuestion).toHaveBeenCalledWith('req-1', [
      expect.objectContaining({ selected: [], custom: null }),
    ]);
  });

  it('submits every picked option of a multi-select question in offered order', () => {
    create([question({ multiSelect: true })]);
    expect(element().textContent).toContain('question.multiHint');

    click('MySQL');
    click('Postgres');
    click('SQLite');
    click('SQLite');
    click('question.submit');

    expect(resolveQuestion).toHaveBeenCalledWith('req-1', [
      {
        header: 'Database',
        question: 'Which database?',
        selected: ['Postgres', 'MySQL'],
        custom: null,
      },
    ]);
  });

  it('keeps picks when a custom answer is added to a multi-select question', () => {
    create([question({ multiSelect: true })]);

    click('Postgres');
    click('question.customLabel');
    const input = element().querySelector('input') as HTMLInputElement;
    input.value = '  CockroachDB ';
    input.dispatchEvent(new Event('input'));
    click('question.submit');

    expect(resolveQuestion).toHaveBeenCalledWith('req-1', [
      expect.objectContaining({ selected: ['Postgres'], custom: 'CockroachDB' }),
    ]);
  });

  it('drops custom text once the custom answer is turned off', () => {
    create([question()]);

    click('question.customLabel');
    const input = element().querySelector('input') as HTMLInputElement;
    input.value = 'Something else';
    input.dispatchEvent(new Event('input'));
    click('SQLite');
    click('question.submit');

    expect(resolveQuestion).toHaveBeenCalledWith('req-1', [
      expect.objectContaining({ selected: ['SQLite'], custom: null }),
    ]);
  });

  describe('Enter in the custom answer', () => {
    function customField(text: string): HTMLInputElement {
      click('question.customLabel');
      const input = element().querySelector('input') as HTMLInputElement;
      input.value = text;
      input.dispatchEvent(new Event('input'));
      return input;
    }

    /** `keyCode` is read-only and not part of what the constructor accepts everywhere. */
    function enter(input: HTMLInputElement, patch: { isComposing?: boolean; keyCode?: number }): void {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing: patch.isComposing ?? false,
      });
      Object.defineProperty(event, 'keyCode', { value: patch.keyCode ?? 13 });
      input.dispatchEvent(event);
      fixture.detectChanges();
    }

    it('submits the answer', () => {
      create([question()]);
      enter(customField('CockroachDB'), {});

      expect(resolveQuestion).toHaveBeenCalledWith('req-1', [
        expect.objectContaining({ selected: [], custom: 'CockroachDB' }),
      ]);
    });

    it('only commits the text while an input method is composing', () => {
      create([question()]);
      enter(customField('にほ'), { isComposing: true });

      expect(resolveQuestion).not.toHaveBeenCalled();
    });

    it('only commits the text when WebKit reports the confirming Enter as key code 229', () => {
      create([question()]);
      enter(customField('にほ'), { keyCode: 229 });

      expect(resolveQuestion).not.toHaveBeenCalled();
    });

    it('stays on the question when the composition is confirmed', () => {
      create([question(), question({ question: 'Which runtime?' })]);
      enter(customField('にほ'), { keyCode: 229 });

      expect(element().textContent).toContain('Which database?');
    });
  });

  describe('focus', () => {
    /** Stands in for the message box, which sits outside the panel. */
    function composer(text: string): HTMLTextAreaElement {
      const host = document.createElement('app-composer');
      const field = document.createElement('textarea');
      field.value = text;
      host.appendChild(field);
      document.body.appendChild(host);
      field.focus();
      return field;
    }

    afterEach(() => {
      document.querySelectorAll('app-composer').forEach((host) => host.remove());
      focusedPanel.set(null);
    });

    it('starts on the first answer', async () => {
      create([question()]);
      await fixture.whenStable();

      expect(document.activeElement).toBe(button('Postgres'));
    });

    it('takes focus from the empty message box', async () => {
      composer('');
      create([question()]);
      await fixture.whenStable();

      expect(document.activeElement).toBe(button('Postgres'));
    });

    it('leaves focus in a message box the user is typing in', async () => {
      const field = composer('One more thing');
      create([question()]);
      await fixture.whenStable();

      expect(document.activeElement).toBe(field);
    });

    it('leaves focus in a field outside the chat', async () => {
      const field = document.createElement('textarea');
      document.body.appendChild(field);
      field.focus();
      create([question()]);
      await fixture.whenStable();

      expect(document.activeElement).toBe(field);
      field.remove();
    });

    it('moves to the first answer of the next question', async () => {
      create([
        question(),
        question({
          question: 'Which runtime?',
          options: [
            { label: 'Node', description: null, recommended: false },
            { label: 'Deno', description: null, recommended: false },
          ],
        }),
      ]);
      await fixture.whenStable();

      button('question.next').focus();
      click('question.next');
      await fixture.whenStable();

      expect(document.activeElement).toBe(button('Node'));
    });

    it('walks the answers and the buttons below with the arrow keys', async () => {
      create([question()]);
      await fixture.whenStable();

      press('ArrowDown');
      expect(document.activeElement).toBe(button('SQLite'));
      press('ArrowUp');
      press('ArrowUp');
      expect(document.activeElement).toBe(button('question.submit'));
      press('ArrowLeft');
      expect(document.activeElement).toBe(button('question.skip'));
      press('ArrowRight');
      press('ArrowRight');
      expect(document.activeElement).toBe(button('Postgres'));
    });

    it('keeps the keyboard on a clicked answer', async () => {
      create([question()]);
      await fixture.whenStable();

      // As in WebKit on macOS, the click itself does not focus the button.
      click('SQLite');
      expect(document.activeElement).toBe(button('SQLite'));
      press('ArrowDown');
      expect(document.activeElement).toBe(button('MySQL'));
    });

    it('enters the answers from the panel itself', async () => {
      create([question()]);
      await fixture.whenStable();

      const panel = element().querySelector('[tabindex="-1"]') as HTMLElement;
      panel.focus();
      press('ArrowDown');
      expect(document.activeElement).toBe(button('Postgres'));
      panel.focus();
      press('ArrowUp');
      expect(document.activeElement).toBe(button('question.submit'));
    });

    it('starts on the first answer again when the panel is reopened', async () => {
      create([question()]);
      await fixture.whenStable();

      click('question.progress');
      click('question.progress');
      await fixture.whenStable();

      expect(document.activeElement).toBe(button('Postgres'));
    });

    it('takes the keyboard back where it was when the chat is asked to focus', async () => {
      create([question()]);
      await fixture.whenStable();
      press('ArrowDown');

      // Summoning the window puts the caret in the empty message box.
      composer('');
      composerFocusNonce.update((nonce) => nonce + 1);
      fixture.detectChanges();
      await fixture.whenStable();

      expect(document.activeElement).toBe(button('SQLite'));
    });

    it('takes the keyboard from a focused side panel', async () => {
      focusedPanel.set('left');
      create([question()]);
      await fixture.whenStable();

      expect(focusedPanel()).toBe('center');
    });

    it('leaves panel focus off when no panel has it', async () => {
      create([question()]);
      await fixture.whenStable();

      expect(focusedPanel()).toBeNull();
    });

    it('keeps left and right for the caret in the custom answer', async () => {
      create([question()]);
      await fixture.whenStable();

      click('question.customLabel');
      const input = element().querySelector('input') as HTMLInputElement;
      input.focus();
      press('ArrowLeft');
      expect(document.activeElement).toBe(input);
      press('ArrowDown');
      expect(document.activeElement).toBe(button('question.skip'));
      press('ArrowUp');
      expect(document.activeElement).toBe(input);
    });

    it('hands focus back to the message box once the question is answered', async () => {
      create([question()]);

      click('question.submit');
      await fixture.whenStable();

      expect(requestComposerFocus).toHaveBeenCalledTimes(1);
    });

    it('hands focus back to the message box once the question is skipped', async () => {
      create([question()]);

      click('question.skip');
      await fixture.whenStable();

      expect(resolveQuestion).toHaveBeenCalledWith('req-1', null);
      expect(requestComposerFocus).toHaveBeenCalledTimes(1);
    });
  });

  describe('position', () => {
    const POSITION_KEY = 'pumr.questionPosition';
    /** The panel's place at the bottom of the chat, in a 1024 by 768 window. */
    const HOME = { left: 300, top: 400, width: 500, height: 300 };

    beforeEach(() => localStorage.removeItem(POSITION_KEY));
    afterEach(() => localStorage.removeItem(POSITION_KEY));

    afterEach(() => focusedPanel.set(null));

    /** The panel, which a drag moves out of the component and into the window. */
    function panel(): HTMLElement {
      return document.querySelector('[data-testid="question-panel"]') as HTMLElement;
    }

    function header(): HTMLButtonElement {
      return panel().querySelector('button') as HTMLButtonElement;
    }

    function resetButton(): HTMLButtonElement | null {
      return panel().querySelector('[data-testid="question-reset-position"]');
    }

    /** Where the panel floats, or null while it sits at the bottom of the chat. */
    function floating(): { left: string; top: string; width: string } | null {
      const { left, top, width } = panel().style;
      return panel().classList.contains('fixed') ? { left, top, width } : null;
    }

    /** Opens a question whose panel has a size, which jsdom does not lay out. */
    function open(height = HOME.height): void {
      create([question()]);
      Object.defineProperty(panel(), 'offsetHeight', { configurable: true, value: height });
      panel().getBoundingClientRect = () => ({ ...HOME, height }) as DOMRect;
    }

    /** Presses the header, moves the pointer by the given distance and lets go. */
    function drag(x: number, y: number): void {
      header().dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }),
      );
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 + x, clientY: 100 + y }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 100 + x, clientY: 100 + y }));
      // The browser ends a press on the header with a click.
      header().click();
      fixture.detectChanges();
    }

    it('sits at the bottom of the chat until it is dragged', () => {
      open();

      expect(floating()).toBeNull();
      expect(resetButton()).toBeNull();
    });

    it('follows a drag of its header at the width it had, and stays open', () => {
      open();

      drag(-40, -120);

      expect(floating()).toEqual({ left: '260px', top: '280px', width: '500px' });
      expect(panel().textContent).toContain('Which database?');
    });

    it('still collapses on a press that stays in place', () => {
      open();

      drag(2, 1);

      expect(floating()).toBeNull();
      expect(panel().textContent).not.toContain('Which database?');
    });

    it('collapses on the click after a drag again', async () => {
      open();

      drag(-40, -120);
      await new Promise((resolve) => setTimeout(resolve));
      header().click();
      fixture.detectChanges();

      expect(panel().textContent).not.toContain('Which database?');
    });

    it('continues a second drag from where the first one ended', () => {
      open();

      drag(-40, -120);
      drag(10, 20);

      expect(floating()).toEqual({ left: '270px', top: '300px', width: '500px' });
    });

    it('is where it was left for the next question', () => {
      open();
      drag(-40, -120);
      fixture.destroy();
      TestBed.resetTestingModule();

      open();

      expect(floating()).toEqual({ left: '260px', top: '280px', width: '500px' });
    });

    it('goes back to the bottom of the chat on request, for the next question too', () => {
      open();
      drag(-40, -120);

      resetButton()?.click();
      fixture.detectChanges();

      expect(floating()).toBeNull();
      expect(panel().style.left).toBe('');
      expect(resetButton()).toBeNull();
      expect(localStorage.getItem(POSITION_KEY)).toBeNull();
    });

    it('does not start a drag from the reset button', () => {
      open();
      drag(-40, -120);

      resetButton()?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }),
      );
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 300 }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 300, clientY: 300 }));
      fixture.detectChanges();

      expect(floating()).toEqual({ left: '260px', top: '280px', width: '500px' });
    });

    it('leaves the chat for the window while it floats, and comes back on a reset', () => {
      open();
      expect(element().contains(panel())).toBe(true);

      drag(-40, -120);
      expect(panel().parentElement).toBe(document.body);

      resetButton()?.click();
      fixture.detectChanges();
      expect(element().contains(panel())).toBe(true);
    });

    it('is gone from the window once the question is', () => {
      open();
      drag(-40, -120);

      fixture.destroy();

      expect(panel()).toBeNull();
    });

    it('hands the keyboard to the chat when it is pressed in the window', () => {
      open();
      drag(-40, -120);
      focusedPanel.set('left');

      panel().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

      expect(focusedPanel()).toBe('center');
    });

    it('still walks the answers with the arrow keys in the window', async () => {
      open();
      await fixture.whenStable();
      drag(-40, -120);

      button('Postgres').focus();
      press('ArrowDown');

      expect(document.activeElement).toBe(button('SQLite'));
    });

    it('goes anywhere in the window, but not out of it', () => {
      open();

      drag(-5000, -5000);
      expect(floating()).toEqual({ left: '8px', top: '8px', width: '500px' });

      drag(9000, 9000);
      expect(floating()).toEqual({ left: '516px', top: '460px', width: '500px' });
    });

    it('keeps its header in reach when it is taller than the window', () => {
      open(900);

      drag(0, 200);

      expect(floating()?.top).toBe('8px');
    });

    it('comes back into a window that was made smaller', async () => {
      open();
      drag(200, 100);
      expect(floating()).toEqual({ left: '500px', top: '460px', width: '500px' });
      const width = window.innerWidth;

      try {
        window.innerWidth = 800;
        window.dispatchEvent(new Event('resize'));
        fixture.detectChanges();

        expect(floating()).toEqual({ left: '292px', top: '460px', width: '500px' });
      } finally {
        window.innerWidth = width;
      }
    });

    it('ignores a saved position that is not one', () => {
      localStorage.setItem(POSITION_KEY, '{"x":"left","y":12}');

      open();

      expect(floating()).toBeNull();
    });

    it('leaves the keyboard on the answers when the header took the focus', async () => {
      open();
      await fixture.whenStable();
      const first = button('Postgres');

      header().dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }),
      );
      header().focus();
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 20 }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 20 }));
      fixture.detectChanges();

      expect(document.activeElement).toBe(first);
      expect(document.body.contains(first)).toBe(true);
    });

    it('lets go of the pointer when the question is answered mid-drag', () => {
      open();
      header().dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }),
      );
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, clientY: 150 }));
      expect(document.body.style.userSelect).toBe('none');

      fixture.destroy();

      expect(document.body.style.userSelect).toBe('');
    });
  });
});
