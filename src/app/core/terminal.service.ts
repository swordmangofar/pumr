import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { api, isTauri } from './api';
import { WorkspaceService } from './workspace.service';

const TERMINAL_KEY = 'pumr.terminal';
export const TERMINAL_MIN_HEIGHT = 120;
const TERMINAL_DEFAULT_HEIGHT = 280;

/** A terminal tab in the dock. Its shell is owned by its `app-terminal-view`. */
export interface TerminalTab {
  /** Local id, known before the shell has started. */
  key: string;
  projectId: string;
  /** Shown as "Terminal 2" until the shell sets a title. */
  number: number;
  title: string | null;
  /** Exit code once the shell has ended with an error. */
  exitCode: number | null;
}

interface PersistedTerminal {
  open?: boolean;
  height?: number;
}

/**
 * Owns the terminal dock: which terminals exist for each project, which one is
 * shown, and whether the dock is open. The shells themselves live in
 * `TerminalView`, one per tab, and end when their tab is closed.
 */
@Injectable({ providedIn: 'root' })
export class TerminalService {
  private readonly workspace = inject(WorkspaceService);

  private readonly tabsState = signal<TerminalTab[]>([]);
  private readonly activeByProject = signal<Record<string, string>>({});
  private readonly openState = signal(false);
  private readonly heightState = signal(TERMINAL_DEFAULT_HEIGHT);
  private readonly focusState = signal(0);
  private nextKey = 0;

  readonly tabs = this.tabsState.asReadonly();
  readonly open = this.openState.asReadonly();
  readonly height = this.heightState.asReadonly();
  /** Bumped whenever the shown terminal should take keyboard focus. */
  readonly focusRequest = this.focusState.asReadonly();
  readonly projectTabs = computed(() => {
    const projectId = this.workspace.activeProject()?.id;
    return projectId ? this.tabsState().filter((tab) => tab.projectId === projectId) : [];
  });
  readonly activeKey = computed(() => {
    const tabs = this.projectTabs();
    if (tabs.length === 0) {
      return null;
    }
    const key = this.activeByProject()[tabs[0].projectId];
    return tabs.some((tab) => tab.key === key) ? key : tabs[tabs.length - 1].key;
  });

  /**
   * Resolves once shells left over from before a page reload are closed; the
   * reloaded page can no longer reach them.
   */
  readonly ready: Promise<void> = isTauri()
    ? api.terminalCloseAll().catch(() => undefined)
    : Promise.resolve();

  constructor() {
    this.restore();

    // An open dock always shows a terminal for the active project.
    effect(() => {
      const project = this.workspace.activeProject();
      if (this.openState() && project && this.projectTabs().length === 0) {
        untracked(() => this.create(project.id));
      }
    });

    // Terminals of a removed project go with it.
    effect(() => {
      const projectIds = new Set(this.workspace.projects().map((project) => project.id));
      const tabs = untracked(this.tabsState);
      if (tabs.some((tab) => !projectIds.has(tab.projectId))) {
        this.tabsState.set(tabs.filter((tab) => projectIds.has(tab.projectId)));
      }
    });
  }

  toggle(): void {
    this.setOpen(!this.openState());
  }

  setOpen(open: boolean): void {
    this.openState.set(open);
    this.persist();
    if (open) {
      this.requestFocus();
    }
  }

  setHeight(height: number): void {
    this.heightState.set(Math.max(TERMINAL_MIN_HEIGHT, Math.round(height)));
    this.persist();
  }

  /** Adds a terminal for `projectId` and shows it. */
  create(projectId: string): void {
    const number =
      Math.max(0, ...this.tabsState().filter((tab) => tab.projectId === projectId).map((tab) => tab.number)) + 1;
    const key = `terminal-${++this.nextKey}`;
    this.tabsState.update((tabs) => [
      ...tabs,
      { key, projectId, number, title: null, exitCode: null },
    ]);
    this.activeByProject.update((active) => ({ ...active, [projectId]: key }));
    this.requestFocus();
  }

  /** Adds a terminal for the active project, opening the dock if needed. */
  createForActiveProject(): void {
    const project = this.workspace.activeProject();
    if (!project) {
      return;
    }
    if (!this.openState()) {
      this.setOpen(true);
    }
    this.create(project.id);
  }

  activate(key: string): void {
    const tab = this.tabsState().find((entry) => entry.key === key);
    if (!tab) {
      return;
    }
    this.activeByProject.update((active) => ({ ...active, [tab.projectId]: key }));
    this.requestFocus();
  }

  /** Closes a terminal; its view ends the shell. */
  close(key: string): void {
    const tabs = this.tabsState();
    const index = tabs.findIndex((tab) => tab.key === key);
    if (index === -1) {
      return;
    }
    const { projectId } = tabs[index];
    const projectTabs = tabs.filter((tab) => tab.projectId === projectId);
    const position = projectTabs.findIndex((tab) => tab.key === key);
    const siblings = projectTabs.filter((tab) => tab.key !== key);
    this.tabsState.set(tabs.filter((tab) => tab.key !== key));
    if (siblings.length === 0) {
      // Hide the dock rather than starting a fresh shell in its place.
      if (projectId === this.workspace.activeProject()?.id) {
        this.setOpen(false);
      }
      return;
    }
    if (this.activeByProject()[projectId] === key) {
      // The tab to the left, as closing browser tabs does.
      const next = siblings[Math.max(0, position - 1)];
      this.activeByProject.update((active) => ({ ...active, [projectId]: next.key }));
      this.requestFocus();
    }
  }

  /** Closes the terminal shown for the active project. */
  closeActive(): void {
    const key = this.activeKey();
    if (key) {
      this.close(key);
    }
  }

  setTitle(key: string, title: string): void {
    this.updateTab(key, { title: title.trim() || null });
  }

  /**
   * Handles a shell that ended. One that exited cleanly (e.g. after `exit`)
   * closes its tab; one that failed stays open so its output can be read.
   */
  exited(key: string, code: number | null): void {
    if (code === 0) {
      this.close(key);
      return;
    }
    this.updateTab(key, { exitCode: code ?? -1 });
  }

  requestFocus(): void {
    this.focusState.update((nonce) => nonce + 1);
  }

  private updateTab(key: string, patch: Partial<TerminalTab>): void {
    this.tabsState.update((tabs) =>
      tabs.map((tab) => (tab.key === key ? { ...tab, ...patch } : tab)),
    );
  }

  private restore(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(TERMINAL_KEY) ?? '{}') as PersistedTerminal;
      if (typeof saved.open === 'boolean') {
        this.openState.set(saved.open);
      }
      if (typeof saved.height === 'number' && Number.isFinite(saved.height)) {
        this.heightState.set(Math.max(TERMINAL_MIN_HEIGHT, saved.height));
      }
    } catch {
      // Ignore unreadable saved state and keep the defaults.
    }
  }

  private persist(): void {
    const data: PersistedTerminal = { open: this.openState(), height: this.heightState() };
    try {
      localStorage.setItem(TERMINAL_KEY, JSON.stringify(data));
    } catch {
      // Storage may be unavailable; the dock then just forgets its layout.
    }
  }
}
