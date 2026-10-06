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
    const found = [...element().querySelectorAll('button')].find((candidate) =>
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
});
