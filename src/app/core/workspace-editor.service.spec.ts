import { TestBed } from '@angular/core/testing';
import { MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { WorkspaceFile } from './models';
import { WorkspaceEditorService } from './workspace-editor.service';

function file(patch: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return { path: 'notes.txt', content: 'alpha\n', language: 'plaintext', binary: false, ...patch };
}

describe('WorkspaceEditorService', () => {
  let editor: WorkspaceEditorService;
  let write: MockInstance<typeof api.writeWorkspaceFile>;

  /** Opens `loaded` in a tab, read from disk as the backend reports it. */
  async function open(loaded: WorkspaceFile): Promise<void> {
    vi.spyOn(api, 'readWorkspaceFile').mockResolvedValue(loaded);
    editor.open('p1', loaded.path);
    await editor.loadFile('p1', loaded.path, false, null);
  }

  function shown(path: string): WorkspaceFile | undefined {
    return editor.editorContent()[editor.editorKey('p1', path)];
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.useFakeTimers();
    write = vi.spyOn(api, 'writeWorkspaceFile').mockResolvedValue();
    editor = TestBed.inject(WorkspaceEditorService);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('saves an edit shortly after it was made', async () => {
    await open(file());

    editor.updateContent('p1', 'notes.txt', 'alpha\nbravo\n');
    expect(editor.isDirty('p1', 'notes.txt')).toBe(true);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);

    expect(write).toHaveBeenCalledWith('p1', 'notes.txt', 'alpha\nbravo\n');
    expect(editor.isDirty('p1', 'notes.txt')).toBe(false);
  });

  it('writes an edit that was not saved yet when its tab is closed', async () => {
    await open(file());

    editor.updateContent('p1', 'notes.txt', 'alpha\nbravo\n');
    editor.close('p1', 'notes.txt');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('p1', 'notes.txt', 'alpha\nbravo\n');
  });

  describe('a file that is not text', () => {
    const image = file({ path: 'logo.png', content: '', binary: true });

    it('is never changed, so that nothing is saved over it', async () => {
      await open(image);

      // What an editor shown for it anyway would report as typed.
      editor.updateContent('p1', 'logo.png', 'typed');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(editor.isDirty('p1', 'logo.png')).toBe(false);
      expect(shown('logo.png')).toEqual(image);
      expect(write).not.toHaveBeenCalled();
    });

    it('is not written when a save is asked for', async () => {
      await open(image);

      await editor.save('p1', 'logo.png');

      expect(write).not.toHaveBeenCalled();
    });

    it('is not written when its tab is closed', async () => {
      await open(image);

      editor.updateContent('p1', 'logo.png', 'typed');
      editor.close('p1', 'logo.png');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(write).not.toHaveBeenCalled();
      expect(editor.openFilesFor('p1')).toEqual([]);
    });
  });
});
