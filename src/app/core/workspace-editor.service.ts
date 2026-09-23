import { Injectable, signal } from '@angular/core';
import { api } from './api';
import { FileDiff, WorkspaceEntry, WorkspaceFile } from './models';

const OPEN_FILES_KEY = 'pumr.workspace.openFiles';
const AUTO_SAVE_MS = 500;

interface PersistedOpenFiles {
  files?: string[];
  active?: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson<T>(key: string, fallback: T, validate: (value: unknown) => boolean): T {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '');
    return validate(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Owns the workspace file editor: open tabs, content, diffs, dirty state and
 * autosave, plus the project file entries used by the tree. All methods take an
 * explicit `projectId`.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceEditorService {
  private readonly workspaceEntriesState = signal<Record<string, WorkspaceEntry[]>>({});
  private readonly openFilesState = signal<Record<string, string[]>>({});
  private readonly activeOpenFileState = signal<Record<string, string | null>>({});
  private readonly editorContentState = signal<Record<string, WorkspaceFile>>({});
  private readonly editorDiffState = signal<Record<string, FileDiff>>({});
  private readonly editorDirtyState = signal<Record<string, boolean>>({});
  private readonly autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly editorContent = this.editorContentState.asReadonly();
  readonly editorDiff = this.editorDiffState.asReadonly();

  constructor() {
    const stored = readJson<Record<string, PersistedOpenFiles>>(OPEN_FILES_KEY, {}, isPlainObject);
    const files: Record<string, string[]> = {};
    const active: Record<string, string | null> = {};
    for (const [projectId, entry] of Object.entries(stored)) {
      files[projectId] = Array.isArray(entry?.files) ? entry.files : [];
      active[projectId] = entry?.active ?? null;
    }
    this.openFilesState.set(files);
    this.activeOpenFileState.set(active);
  }

  workspaceEntriesFor(projectId: string): WorkspaceEntry[] {
    return this.workspaceEntriesState()[projectId] ?? [];
  }

  async loadWorkspaceEntries(projectId: string, force = false): Promise<void> {
    if (!force && this.workspaceEntriesState()[projectId]) {
      return;
    }
    try {
      const entries = await api.listWorkspaceEntries(projectId);
      this.workspaceEntriesState.update((state) => ({ ...state, [projectId]: entries }));
    } catch {
      // best effort
    }
  }

  openFilesFor(projectId: string): string[] {
    return this.openFilesState()[projectId] ?? [];
  }

  activeFileFor(projectId: string): string | null {
    return this.activeOpenFileState()[projectId] ?? null;
  }

  editorKey(projectId: string, path: string): string {
    return `${projectId}\n${path}`;
  }

  open(projectId: string, path: string): void {
    const files = this.openFilesState()[projectId] ?? [];
    if (!files.includes(path)) {
      this.openFilesState.update((state) => ({ ...state, [projectId]: [...files, path] }));
    }
    this.setActive(projectId, path);
  }

  setActive(projectId: string, path: string): void {
    this.activeOpenFileState.update((state) => ({ ...state, [projectId]: path }));
    this.persistOpenFiles();
  }

  close(projectId: string, path: string): void {
    const files = (this.openFilesState()[projectId] ?? []).filter((entry) => entry !== path);
    this.openFilesState.update((state) => ({ ...state, [projectId]: files }));
    const key = this.editorKey(projectId, path);
    const pending = this.editorContentState()[key];
    if (pending && this.editorDirtyState()[key]) {
      void api.writeWorkspaceFile(projectId, path, pending.content).catch(() => undefined);
    }
    this.clearAutoSave(projectId, path);
    this.editorContentState.update((state) => {
      const next = { ...state };
      delete next[key];
      return next;
    });
    this.clearEditorDiff(key);
    this.editorDirtyState.update((state) => {
      const next = { ...state };
      delete next[key];
      return next;
    });
    if (this.activeOpenFileState()[projectId] === path) {
      const next = files[files.length - 1] ?? null;
      this.activeOpenFileState.update((state) => ({ ...state, [projectId]: next }));
    }
    this.persistOpenFiles();
  }

  async loadFile(
    projectId: string,
    path: string,
    force: boolean,
    diffSessionId: string | null,
  ): Promise<void> {
    const key = this.editorKey(projectId, path);
    if (!force && this.editorDirtyState()[key]) {
      return;
    }
    const [file, diff] = await Promise.all([
      api.readWorkspaceFile(projectId, path).catch(() => null),
      diffSessionId ? api.getFileDiff(diffSessionId, path).catch(() => null) : Promise.resolve(null),
    ]);
    if (file) {
      this.editorContentState.update((state) => ({ ...state, [key]: file }));
      this.editorDirtyState.update((state) => {
        const next = { ...state };
        delete next[key];
        return next;
      });
    }
    if (diff) {
      this.editorDiffState.update((state) => ({ ...state, [key]: diff }));
    } else {
      this.clearEditorDiff(key);
    }
  }

  updateContent(projectId: string, path: string, content: string): void {
    const key = this.editorKey(projectId, path);
    const file = this.editorContentState()[key];
    if (!file || file.content === content) {
      return;
    }
    this.editorContentState.update((state) => ({ ...state, [key]: { ...file, content } }));
    this.editorDirtyState.update((state) => ({ ...state, [key]: true }));
    this.scheduleAutoSave(projectId, path);
  }

  isDirty(projectId: string, path: string): boolean {
    return this.editorDirtyState()[this.editorKey(projectId, path)] ?? false;
  }

  async save(projectId: string, path: string): Promise<void> {
    const key = this.editorKey(projectId, path);
    const file = this.editorContentState()[key];
    if (!file) {
      return;
    }
    const saved = file.content;
    try {
      await api.writeWorkspaceFile(projectId, path, saved);
    } catch {
      return;
    }
    const current = this.editorContentState()[key];
    if (current && current.content !== saved) {
      this.scheduleAutoSave(projectId, path);
      return;
    }
    this.editorDirtyState.update((state) => {
      const next = { ...state };
      delete next[key];
      return next;
    });
  }

  async discard(projectId: string, path: string, diffSessionId: string | null): Promise<void> {
    this.clearAutoSave(projectId, path);
    await this.loadFile(projectId, path, true, diffSessionId);
  }

  private scheduleAutoSave(projectId: string, path: string): void {
    const key = this.editorKey(projectId, path);
    this.clearAutoSave(projectId, path);
    const timer = setTimeout(() => {
      this.autoSaveTimers.delete(key);
      void this.save(projectId, path);
    }, AUTO_SAVE_MS);
    this.autoSaveTimers.set(key, timer);
  }

  private clearAutoSave(projectId: string, path: string): void {
    const key = this.editorKey(projectId, path);
    const timer = this.autoSaveTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.autoSaveTimers.delete(key);
    }
  }

  private clearEditorDiff(key: string): void {
    this.editorDiffState.update((state) => {
      const next = { ...state };
      delete next[key];
      return next;
    });
  }

  private persistOpenFiles(): void {
    const data: Record<string, PersistedOpenFiles> = {};
    for (const [projectId, files] of Object.entries(this.openFilesState())) {
      data[projectId] = { files, active: this.activeOpenFileState()[projectId] ?? null };
    }
    localStorage.setItem(OPEN_FILES_KEY, JSON.stringify(data));
  }
}