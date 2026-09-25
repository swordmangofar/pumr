import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { Channel } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { GitService } from './git.service';
import {
  PermissionRequestEvent,
  QuestionRequestEvent,
  RoutedEvent,
  Session,
  StreamEvent,
} from './models';
import { ProcessService } from './process.service';
import { SettingsService } from './settings.service';
import { SoundService } from './sound.service';
import { WorkspaceEditorService } from './workspace-editor.service';
import { WorkspaceService } from './workspace.service';

function session(id: string, parentSessionId: string | null = null): Session {
  return {
    id,
    projectId: 'project',
    title: id,
    model: 'model',
    reasoningEffort: null,
    provider: null,
    systemPrompt: null,
    createdAt: 0,
    updatedAt: 0,
    cost: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    messageCount: 1,
    parentSessionId,
    agentStatus: parentSessionId ? 'running' : null,
    archived: false,
    modeId: null,
    limitReached: false,
    autoContinue: false,
  };
}

function permission(requestId: string): PermissionRequestEvent {
  return {
    kind: 'permissionRequest',
    requestId,
    promptKind: 'command',
    title: 'Run command?',
    detail: 'Approval required',
    command: 'npm install',
    path: null,
    folder: null,
    url: null,
    suggestedRule: null,
    segments: [],
    risk: null,
    scopeOptions: [],
    folders: [],
    hosts: [],
  };
}

function question(requestId: string): QuestionRequestEvent {
  return {
    kind: 'questionRequest',
    requestId,
    questions: [{ header: 'Target', question: 'Which crate?', options: [], multiSelect: false }],
  };
}

describe('WorkspaceService after a webview reload', () => {
  let workspace: WorkspaceService;
  let play: ReturnType<typeof vi.fn>;
  let attached: Channel<RoutedEvent>[];
  let finishTurn: (attached: boolean) => void;

  function emit(sessionId: string, event: StreamEvent): void {
    attached[attached.length - 1].onmessage({ sessionId, event });
  }

  beforeEach(async () => {
    // `new Channel()` registers its callback with the Tauri runtime.
    let callbackId = 0;
    Object.assign(window, {
      __TAURI_INTERNALS__: { transformCallback: () => ++callbackId, unregisterCallback: () => {} },
    });
    play = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        WorkspaceService,
        { provide: SettingsService, useValue: { settings: signal(null) } },
        { provide: SoundService, useValue: { play } },
        { provide: TranslocoService, useValue: { translate: (key: string) => key } },
        { provide: ProcessService, useValue: { processes: signal([]) } },
        { provide: GitService, useValue: {} },
        {
          provide: WorkspaceEditorService,
          useValue: { loadWorkspaceEntries: async () => {}, activeFileFor: () => null },
        },
      ],
    });
    workspace = TestBed.inject(WorkspaceService);

    const chat = session('chat');
    const subagent = session('subagent', 'chat');
    vi.spyOn(api, 'listProjects').mockResolvedValue([]);
    vi.spyOn(api, 'listSessions').mockResolvedValue([chat]);
    vi.spyOn(api, 'listSubSessionsForProject').mockResolvedValue([subagent]);
    vi.spyOn(api, 'listSubSessions').mockResolvedValue([{ ...subagent, agentStatus: 'done' }]);
    vi.spyOn(api, 'listMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getSpend').mockRejectedValue(new Error('no spend'));
    vi.spyOn(api, 'getSessionChanges').mockResolvedValue([]);
    vi.spyOn(api, 'getProjectRules').mockResolvedValue([]);
    vi.spyOn(api, 'listRunningTurns').mockResolvedValue({
      sessionIds: ['chat'],
      permissions: [{ sessionId: 'subagent', event: permission('p1') }],
      questions: [],
    });
    attached = [];
    vi.spyOn(api, 'attachSession').mockImplementation((_sessionId, channel) => {
      attached.push(channel);
      return new Promise<boolean>((resolve) => (finishTurn = resolve));
    });
    await workspace.reloadSessions('project');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('resumes a running turn with its pending prompts and a fresh channel', async () => {
    await workspace.resumeRunningTurns();

    expect(api.attachSession).toHaveBeenCalledWith('chat', attached[0]);
    expect(workspace.isStreaming('chat')).toBe(true);
    expect(workspace.isStreaming('subagent')).toBe(true);
    expect(workspace.sessionAttention('chat')).toBe('permission');

    // The attach replays the prompt it restored: shown once, no second sound.
    emit('subagent', permission('p1'));
    expect(play).not.toHaveBeenCalled();
    emit('chat', question('q1'));
    expect(play).toHaveBeenCalledTimes(1);

    emit('subagent', { kind: 'permissionResolved', requestId: 'p1', allowed: true });
    expect(workspace.sessionAttention('chat')).toBe('question');
    // A replay racing the resolution must not resurrect the answered prompt.
    emit('subagent', permission('p1'));
    expect(workspace.sessionAttention('chat')).toBe('question');

    finishTurn(true);
    await vi.waitFor(() => expect(workspace.isStreaming('chat')).toBe(false));
    expect(workspace.isStreaming('subagent')).toBe(false);
    expect(workspace.sessionAttention('chat')).toBeNull();
  });

  it('attaches each running turn only once', async () => {
    await workspace.resumeRunningTurns();
    await workspace.resumeRunningTurns();

    expect(api.attachSession).toHaveBeenCalledTimes(1);
  });

  it('does not restore a prompt the user already answered', async () => {
    vi.spyOn(api, 'resolveQuestion').mockResolvedValue();
    vi.mocked(api.listRunningTurns).mockResolvedValue({
      sessionIds: [],
      permissions: [],
      questions: [{ sessionId: 'chat', event: question('q1') }],
    });
    await workspace.resumeRunningTurns();
    expect(workspace.sessionAttention('chat')).toBe('question');

    await workspace.resolveQuestion('q1', null);
    // The backend can still list it until the waiting tool call wakes up.
    await workspace.resumeRunningTurns();
    expect(workspace.sessionAttention('chat')).toBeNull();
  });
});
