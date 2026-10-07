import { Pipe, PipeTransform, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { MEMORY_MAX_ENTRIES } from '../../core/memory';
import { MemoryEntry, Settings } from '../../core/models';
import { FALLBACK_SETTINGS } from '../../core/settings.service';
import { MemorySettings } from './memory-settings';
import { SettingsDraftService } from './settings-draft.service';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

function entry(id: string, text: string): MemoryEntry {
  return { id, text };
}

describe('MemorySettings', () => {
  let fixture: ComponentFixture<MemorySettings>;
  let draft: ReturnType<typeof signal<Settings>>;

  function create(patch: Partial<Settings> = {}): void {
    draft = signal<Settings>({ ...FALLBACK_SETTINGS, ...patch });
    const stub = {
      draft,
      patch: (key: keyof Settings, value: Settings[keyof Settings]) => {
        draft.update((current) => ({ ...current, [key]: value }));
      },
    };
    TestBed.configureTestingModule({
      providers: [{ provide: SettingsDraftService, useValue: stub }],
    });
    TestBed.overrideComponent(MemorySettings, {
      remove: { imports: [TranslocoPipe] },
      add: { imports: [StubTranslocoPipe] },
    });
    fixture = TestBed.createComponent(MemorySettings);
    fixture.detectChanges();
  }

  function byTestId(id: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
  }

  function toggle(id: string): HTMLButtonElement {
    return byTestId(id)?.querySelector('button[role="switch"]') as HTMLButtonElement;
  }

  function rows(): HTMLElement[] {
    return [...fixture.nativeElement.querySelectorAll('[data-testid="memory-entry"]')];
  }

  function click(target: HTMLElement | null): void {
    target?.click();
    fixture.detectChanges();
  }

  it('lists what is remembered and says when there is nothing', () => {
    create();
    expect(byTestId('no-memories')).not.toBeNull();
    expect(byTestId('memory-count')?.textContent?.trim()).toBe(`0/${MEMORY_MAX_ENTRIES}`);

    draft.update((current) => ({
      ...current,
      memories: [entry('a', 'Keep answers short.'), entry('b', 'Use tabs.')],
    }));
    fixture.detectChanges();
    expect(byTestId('no-memories')).toBeNull();
    expect(rows().map((row) => row.querySelector('textarea')?.value)).toEqual([
      'Keep answers short.',
      'Use tabs.',
    ]);
  });

  it('edits, removes and adds entries in the draft', () => {
    create({ memories: [entry('a', 'Keep answers short.'), entry('b', 'Use tabs.')] });

    const first = rows()[0].querySelector('textarea') as HTMLTextAreaElement;
    first.value = 'Keep answers to one paragraph.';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    click(rows()[1].querySelector('button'));
    expect(draft().memories).toEqual([entry('a', 'Keep answers to one paragraph.')]);

    click(byTestId('add-memory'));
    expect(draft().memories).toHaveLength(2);
    expect(draft().memories[1].text).toBe('');
    expect(draft().memories[1].id).not.toBe('');
    // The field of the entry that was edited kept its place.
    expect(rows()[0].querySelector('textarea')?.value).toBe('Keep answers to one paragraph.');
  });

  it('takes no more entries than the agent is sent', () => {
    const full = Array.from({ length: MEMORY_MAX_ENTRIES }, (_, index) =>
      entry(String(index), `Preference ${index}.`),
    );
    create({ memories: full });
    expect((byTestId('add-memory') as HTMLButtonElement).disabled).toBe(true);

    click(rows()[0].querySelector('button'));
    expect((byTestId('add-memory') as HTMLButtonElement).disabled).toBe(false);
  });

  it('switches the suggestions off on their own', () => {
    create();
    expect(toggle('memory-suggestions').getAttribute('aria-checked')).toBe('true');
    click(toggle('memory-suggestions'));
    expect(draft().memorySuggestions).toBe(false);
    expect(draft().memoryEnabled).toBe(true);
  });

  it('has nothing to suggest for while the memory is off', () => {
    create();
    click(toggle('memory-enabled'));
    expect(draft().memoryEnabled).toBe(false);
    // The choice for the suggestions is kept for when the memory is back on.
    expect(draft().memorySuggestions).toBe(true);
    expect(toggle('memory-suggestions').disabled).toBe(true);
    expect(toggle('memory-suggestions').getAttribute('aria-checked')).toBe('false');
  });
});
