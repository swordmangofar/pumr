import { Component, Pipe, PipeTransform, booleanAttribute, input, output } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TranslocoPipe } from '@jsverse/transloco';
import { PendingModelChoice } from '../core/models';
import { WorkspaceService } from '../core/workspace.service';
import { ModelChoiceOverlay } from './model-choice-overlay';
import { ModelSelect } from './model-select';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

@Component({ selector: 'app-model-select', template: '' })
class StubModelSelect {
  readonly value = input<string | null>(null);
  readonly only = input<readonly string[] | null>(null);
  readonly docked = input(false, { transform: booleanAttribute });
  readonly label = input<string | null>(null);
  readonly placeholder = input('');
  readonly valueChange = output<string | null>();
}

function request(patch: Partial<PendingModelChoice> = {}): PendingModelChoice {
  return {
    kind: 'modelChoiceRequest',
    requestId: 'req-1',
    sessionId: 'session',
    query: 'gemini flash',
    candidates: ['google/gemini-flash', 'google/gemini-flash-lite'],
    ...patch,
  };
}

describe('ModelChoiceOverlay', () => {
  let fixture: ComponentFixture<ModelChoiceOverlay>;
  let resolveModelChoice: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resolveModelChoice = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [{ provide: WorkspaceService, useValue: { resolveModelChoice } }],
    });
    TestBed.overrideComponent(ModelChoiceOverlay, {
      remove: { imports: [TranslocoPipe, ModelSelect] },
      add: { imports: [StubTranslocoPipe, StubModelSelect] },
    });
    fixture = TestBed.createComponent(ModelChoiceOverlay);
    fixture.componentRef.setInput('request', request());
    fixture.detectChanges();
  });

  function select(): StubModelSelect {
    return fixture.debugElement.query(By.directive(StubModelSelect)).componentInstance;
  }

  function click(text: string): void {
    const element = fixture.nativeElement as HTMLElement;
    const found = [...element.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes(text),
    );
    if (!found) {
      throw new Error(`no button containing "${text}"`);
    }
    found.click();
    fixture.detectChanges();
  }

  it('offers only the suggested models and preselects the closest', () => {
    expect(select().only()).toEqual(['google/gemini-flash', 'google/gemini-flash-lite']);
    expect(select().value()).toBe('google/gemini-flash');

    click('modelChoice.confirm');
    expect(resolveModelChoice).toHaveBeenCalledWith('req-1', 'google/gemini-flash');
  });

  it('answers with the model picked in the dropdown', () => {
    select().valueChange.emit('google/gemini-flash-lite');
    fixture.detectChanges();

    click('modelChoice.confirm');
    expect(resolveModelChoice).toHaveBeenCalledWith('req-1', 'google/gemini-flash-lite');
  });

  it('lists every model on request and the suggestions again after', () => {
    click('modelChoice.showAll');
    expect(select().only()).toBeNull();

    click('modelChoice.showSuggested');
    expect(select().only()).toEqual(['google/gemini-flash', 'google/gemini-flash-lite']);
  });

  it('skips without picking a model', () => {
    click('question.skip');
    expect(resolveModelChoice).toHaveBeenCalledWith('req-1', null);
  });

  it('starts over with the suggestions of a new prompt', () => {
    select().valueChange.emit('google/gemini-flash-lite');
    fixture.componentRef.setInput(
      'request',
      request({ requestId: 'req-2', query: 'gpt', candidates: ['openai/gpt-5'] }),
    );
    fixture.detectChanges();

    expect(select().value()).toBe('openai/gpt-5');
    click('modelChoice.confirm');
    expect(resolveModelChoice).toHaveBeenCalledWith('req-2', 'openai/gpt-5');
  });
});
