import { Pipe, PipeTransform, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { beforeEach, describe, expect, it } from 'vitest';
import { GitDiffLine, GitDiffLineKind, GitHunkDiff } from '../core/models';
import { MonacoService } from '../core/monaco.service';
import { ThemeService } from '../core/theme.service';
import { DiffQuestion, HunkDiffView, LineActionRequest } from './hunk-diff-view';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

let nextId = 0;

function line(
  kind: GitDiffLineKind,
  text: string,
  oldLine: number | null,
  newLine: number | null,
): GitDiffLine {
  return { id: nextId++, kind, oldLine, newLine, text, noNewline: false };
}

function diff(patch: Partial<GitHunkDiff> = {}): GitHunkDiff {
  nextId = 0;
  return {
    path: 'src/a.txt',
    staged: false,
    status: 'M',
    language: 'plaintext',
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        section: 'intro',
        lines: [
          line('context', 'one', 1, 1),
          line('del', 'two', 2, null),
          line('add', 'TWO', null, 2),
          line('add', 'extra', null, 3),
          line('context', 'three', 3, 4),
        ],
      },
      {
        oldStart: 20,
        oldLines: 2,
        newStart: 21,
        newLines: 1,
        section: '',
        lines: [line('context', 'twenty', 20, 21), line('del', 'gone', 21, null)],
      },
    ],
    additions: 2,
    deletions: 2,
    binary: false,
    tooLarge: false,
    blocked: null,
    fingerprint: 'fp',
    ...patch,
  };
}

describe('HunkDiffView', () => {
  let fixture: ComponentFixture<HunkDiffView>;
  let actions: LineActionRequest[];
  let questions: DiffQuestion[];

  async function render(
    value: GitHunkDiff,
    layout: 'unified' | 'split' = 'unified',
  ): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        { provide: MonacoService, useValue: { colorize: async () => '' } },
        { provide: ThemeService, useValue: { current: signal({ id: 'dark' }) } },
        {
          provide: TranslocoService,
          useValue: {
            translate: (key: string, params: Record<string, unknown> = {}) =>
              `${key} ${JSON.stringify(params)}`,
          },
        },
      ],
    });
    TestBed.overrideComponent(HunkDiffView, {
      remove: { imports: [TranslocoPipe] },
      add: { imports: [StubTranslocoPipe] },
    });
    fixture = TestBed.createComponent(HunkDiffView);
    fixture.componentRef.setInput('diff', value);
    fixture.componentRef.setInput('layout', layout);
    actions = [];
    questions = [];
    fixture.componentInstance.lineAction.subscribe((request) => actions.push(request));
    fixture.componentInstance.ask.subscribe((question) => questions.push(question));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function rows(): HTMLElement[] {
    return [...fixture.nativeElement.querySelectorAll('.diff-row')] as HTMLElement[];
  }

  function row(text: string): HTMLElement {
    const found = rows().find(
      (element) => element.querySelector('.diff-code')?.textContent === text,
    );
    if (!found) {
      throw new Error(`no row ${text}`);
    }
    return found;
  }

  function press(element: HTMLElement, init: MouseEventInit = {}): void {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ...init }));
    document.dispatchEvent(new MouseEvent('mouseup'));
    fixture.detectChanges();
  }

  function key(key: string, init: KeyboardEventInit = {}): void {
    const root = fixture.nativeElement.querySelector('[role="region"]') as HTMLElement;
    root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    fixture.detectChanges();
  }

  function selectedTexts(): string[] {
    return rows()
      .filter((element) => element.className.includes('bg-accent/25'))
      .map((element) => element.querySelector('.diff-code')?.textContent ?? '');
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('renders hunk headers and every line with its numbers', async () => {
    await render(diff());
    expect(fixture.nativeElement.textContent).toContain('@@ -1,3 +1,4 @@');
    expect(rows().map((element) => element.querySelector('.diff-code')?.textContent)).toEqual([
      'one',
      'two',
      'TWO',
      'extra',
      'three',
      'twenty',
      'gone',
    ]);
  });

  it('selects a line on click, a range on shift-click and adds with cmd-click', async () => {
    await render(diff());
    press(row('two'));
    expect(selectedTexts()).toEqual(['two']);

    press(row('extra'), { shiftKey: true });
    expect(selectedTexts()).toEqual(['two', 'TWO', 'extra']);

    press(row('gone'), { metaKey: true });
    expect(selectedTexts()).toEqual(['two', 'TWO', 'extra', 'gone']);

    press(row('TWO'), { metaKey: true });
    expect(selectedTexts()).toEqual(['two', 'extra', 'gone']);
  });

  it('stages and discards the selection with the keyboard', async () => {
    await render(diff());
    press(row('TWO'));
    key('s');
    key('Backspace');
    expect(actions).toEqual([
      { action: 'stage', lines: [2] },
      { action: 'discard', lines: [2] },
    ]);
  });

  it('unstages only on a staged diff', async () => {
    await render(diff({ staged: true }));
    press(row('gone'));
    key('s');
    key('u');
    expect(actions).toEqual([{ action: 'unstage', lines: [6] }]);
  });

  it('jumps between hunks and picks their changes', async () => {
    await render(diff());
    key('j');
    expect(selectedTexts()).toEqual(['two', 'TWO', 'extra']);
    key('j');
    expect(selectedTexts()).toEqual(['gone']);
    key('k');
    expect(selectedTexts()).toEqual(['two', 'TWO', 'extra']);
  });

  it('moves and extends the selection with the arrow keys', async () => {
    await render(diff());
    key('ArrowDown');
    expect(selectedTexts()).toEqual(['two']);
    key('ArrowDown', { shiftKey: true });
    expect(selectedTexts()).toEqual(['two', 'TWO']);
  });

  it('applies a whole hunk from its header', async () => {
    await render(diff());
    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    buttons.find((button) => button.textContent?.trim() === 'git.diff.stageHunk')?.click();
    expect(actions).toEqual([{ action: 'stage', lines: [1, 2, 3] }]);
  });

  it('hides line actions while they are blocked', async () => {
    await render(diff({ blocked: 'whitespace' }));
    press(row('TWO'));
    key('s');
    expect(actions).toEqual([]);
    expect(fixture.nativeElement.textContent).toContain('git.diff.blocked.whitespace');
    expect(fixture.nativeElement.textContent).not.toContain('git.diff.stageHunk');
  });

  it('hands the selection to the chat as a diff excerpt', async () => {
    await render(diff());
    press(row('two'));
    press(row('extra'), { shiftKey: true });
    const ask = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button: HTMLButtonElement) => button.textContent?.includes('git.diff.ask'),
    ) as HTMLButtonElement;
    ask.click();
    expect(questions).toHaveLength(1);
    expect(questions[0].path).toBe('src/a.txt');
    expect(questions[0].text).toContain('git.diff.askUnstaged');
    expect(questions[0].text).toContain('"from":2,"to":3');
    expect(questions[0].text).toContain('```diff\n-two\n+TWO\n+extra\n```');
  });

  it('selects one side at a time in the split layout', async () => {
    await render(diff(), 'split');
    press(row('two'));
    press(row('three'), { shiftKey: true });
    expect(selectedTexts()).toEqual(['two']);
  });

  it('shows placeholders instead of rows for binary files', async () => {
    await render(diff({ hunks: [], binary: true, blocked: 'binary' }));
    expect(rows()).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('common.binaryFile');
  });
});
