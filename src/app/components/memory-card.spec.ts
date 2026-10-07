import { Pipe, PipeTransform, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { MemorySuggestion, Settings } from '../core/models';
import { FALLBACK_SETTINGS, SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { MemoryCard } from './memory-card';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string, params?: Record<string, unknown>): string {
    return params ? `${value} ${JSON.stringify(params)}` : value;
  }
}

function suggestion(patch: Partial<MemorySuggestion> = {}): MemorySuggestion {
  return {
    id: 7,
    text: 'Ask me for every finding whether to fix it.',
    requested: false,
    replaces: null,
    createdAt: 1,
    ...patch,
  };
}

describe('MemoryCard', () => {
  let fixture: ComponentFixture<MemoryCard>;
  let resolveMemorySuggestion: ReturnType<typeof vi.fn>;
  let settings: ReturnType<typeof signal<Settings | null>>;

  function create(proposed = suggestion()): void {
    resolveMemorySuggestion = vi.fn().mockResolvedValue(undefined);
    settings = signal<Settings | null>({ ...FALLBACK_SETTINGS });
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkspaceService, useValue: { resolveMemorySuggestion } },
        { provide: SettingsService, useValue: { settings } },
      ],
    });
    TestBed.overrideComponent(MemoryCard, {
      remove: { imports: [TranslocoPipe] },
      add: { imports: [StubTranslocoPipe] },
    });
    fixture = TestBed.createComponent(MemoryCard);
    fixture.componentRef.setInput('sessionId', 'session-1');
    fixture.componentRef.setInput('suggestion', proposed);
    fixture.detectChanges();
  }

  function element(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function button(action: string): HTMLButtonElement | null {
    return element().querySelector(`button[data-action="${action}"]`);
  }

  function textarea(): HTMLTextAreaElement {
    return element().querySelector('textarea') as HTMLTextAreaElement;
  }

  function type(text: string): void {
    textarea().value = text;
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  }

  async function click(action: string): Promise<void> {
    button(action)?.click();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('shows the proposal and where it came from', () => {
    create();
    expect(textarea().value).toBe('Ask me for every finding whether to fix it.');
    expect(element().textContent).toContain('memory.noticed');
    expect(element().querySelector('[data-testid="memory-replaces"]')).toBeNull();
  });

  it('says when the user asked for it and what it replaces', () => {
    create(suggestion({ requested: true, replaces: { id: 'a', text: 'Keep answers short.' } }));
    expect(element().textContent).toContain('memory.requested');
    expect(element().textContent).not.toContain('memory.noticed');
    expect(element().querySelector('[data-testid="memory-replaces"]')?.textContent).toContain(
      'memory.replaces {"text":"Keep answers short."}',
    );
  });

  it('remembers the text as the user edited it', async () => {
    create();
    type('Ask before every fix.');
    await click('save');
    expect(resolveMemorySuggestion).toHaveBeenCalledWith(
      'session-1',
      7,
      'save',
      'Ask before every fix.',
    );
  });

  it('does not offer to remember an empty text', () => {
    create();
    type('   ');
    expect(button('save')?.disabled).toBe(true);
    expect(button('decline')?.disabled).toBe(false);
  });

  it('declines without sending a text', async () => {
    create();
    type('Something else.');
    await click('decline');
    expect(resolveMemorySuggestion).toHaveBeenCalledWith('session-1', 7, 'decline', null);
  });

  it("switches the suggestions off with Don't ask again", async () => {
    create();
    await click('disable');
    expect(resolveMemorySuggestion).toHaveBeenCalledWith('session-1', 7, 'disable', null);
  });

  it('has nothing to switch off once the suggestions are off', () => {
    create();
    expect(button('disable')).not.toBeNull();
    settings.set({ ...FALLBACK_SETTINGS, memorySuggestions: false });
    fixture.detectChanges();
    expect(button('disable')).toBeNull();
  });

  it('stays and says so when the answer could not be stored', async () => {
    create();
    resolveMemorySuggestion.mockRejectedValue('disk full');
    await click('save');
    expect(element().querySelector('[role="alert"]')?.textContent).toContain('disk full');
    expect(button('save')?.disabled).toBe(false);
  });

  it('starts from the text of another suggestion', () => {
    create();
    type('Edited.');
    fixture.componentRef.setInput('suggestion', suggestion({ id: 8, text: 'Use tabs.' }));
    fixture.detectChanges();
    expect(textarea().value).toBe('Use tabs.');
  });
});
