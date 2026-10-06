import { Component, Pipe, PipeTransform, input, output, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../core/api';
import { FileDiff, WorkspaceFile } from '../core/models';
import { FALLBACK_SETTINGS, SettingsService } from '../core/settings.service';
import { WorkspaceEditorService } from '../core/workspace-editor.service';
import { WorkspaceService } from '../core/workspace.service';
import { DiffView } from './diff-view';
import { FileView } from './file-view';
import { WorkspaceEditor } from './workspace-editor';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

/** Stands in for the Monaco editor of a file. */
@Component({ selector: 'app-file-view', standalone: true, template: '' })
class StubFileView {
  readonly file = input<WorkspaceFile | null>(null);
  readonly readOnly = input(true);
  readonly contentChange = output<string>();
}

@Component({ selector: 'app-diff-view', standalone: true, template: '' })
class StubDiffView {
  readonly diff = input<FileDiff | null>(null);
  readonly editable = input(false);
  readonly sideBySide = input(false);
  readonly contentChange = output<string>();
}

describe('WorkspaceEditor', () => {
  let fixture: ComponentFixture<WorkspaceEditor>;
  let editor: WorkspaceEditorService;

  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(api, 'writeWorkspaceFile').mockResolvedValue();
  });

  afterEach(() => vi.restoreAllMocks());

  /** Opens `file` in a tab of the project shown, as the backend read it. */
  async function open(file: WorkspaceFile): Promise<void> {
    vi.spyOn(api, 'readWorkspaceFile').mockResolvedValue(file);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WorkspaceService,
          useValue: {
            browseProject: signal({ id: 'p1' }),
            sessionIn: () => null,
            changesFor: () => [],
            loadEditorFile: (projectId: string, path: string) =>
              editor.loadFile(projectId, path, false, null),
          },
        },
        { provide: SettingsService, useValue: { settings: signal(FALLBACK_SETTINGS) } },
      ],
    });
    TestBed.overrideComponent(WorkspaceEditor, {
      remove: { imports: [TranslocoPipe, FileView, DiffView] },
      add: { imports: [StubTranslocoPipe, StubFileView, StubDiffView] },
    });
    editor = TestBed.inject(WorkspaceEditorService);
    editor.open('p1', file.path);
    fixture = TestBed.createComponent(WorkspaceEditor);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  function fileView(): StubFileView | null {
    const found = fixture.debugElement.query(
      (node) => node.componentInstance instanceof StubFileView,
    );
    return found ? (found.componentInstance as StubFileView) : null;
  }

  function notice(): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector('[data-testid="binary-file"]');
  }

  it('opens a text file in an editor that takes changes', async () => {
    await open({ path: 'notes.txt', content: 'alpha\n', language: 'plaintext', binary: false });

    expect(fileView()?.file()?.content).toBe('alpha\n');
    expect(fileView()?.readOnly()).toBe(false);
    expect(notice()).toBeNull();
  });

  it('says that a file is not text instead of showing it as an empty editor', async () => {
    await open({ path: 'logo.png', content: '', language: 'plaintext', binary: true });

    expect(notice()?.textContent).toContain('common.binaryFile');
    // Nothing is there to type into, so nothing can be saved over the file.
    expect(fileView()).toBeNull();
    expect(editor.isDirty('p1', 'logo.png')).toBe(false);
  });
});
