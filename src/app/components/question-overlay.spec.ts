import { Pipe, PipeTransform } from '@angular/core';
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

  function create(questions: QuestionItem[]): void {
    resolveQuestion = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [{ provide: WorkspaceService, useValue: { resolveQuestion } }],
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
});
