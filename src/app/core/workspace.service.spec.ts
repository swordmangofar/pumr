import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { Channel } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { GitService } from './git.service';
import {
  Message,
  PermissionRequestEvent,
  Project,
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
    interrupted: false,
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
    justification: null,
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
  let followWorkingTree: ReturnType<typeof vi.fn>;
  let loadWorkspaceEntries: ReturnType<typeof vi.fn>;
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
    followWorkingTree = vi.fn(async () => {});
    loadWorkspaceEntries = vi.fn(async () => {});
    TestBed.configureTestingModule({
      providers: [
        WorkspaceService,
        { provide: SettingsService, useValue: { settings: signal(null) } },
        { provide: SoundService, useValue: { play } },
        { provide: TranslocoService, useValue: { translate: (key: string) => key } },
        { provide: ProcessService, useValue: { processes: signal([]) } },
        { provide: GitService, useValue: { followWorkingTree } },
        {
          provide: WorkspaceEditorService,
          useValue: { loadWorkspaceEntries, activeFileFor: () => null },
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
      modelChoices: [],
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

  it('opens the output of a command that keeps printing and keeps its latest part', async () => {
    await workspace.resumeRunningTurns();
    vi.useFakeTimers();
    try {
      const tools = () => workspace.liveToolsFor('chat');
      const start = (callId: string): StreamEvent => ({
        kind: 'toolStart',
        callId,
        name: 'bash',
        summary: callId,
        arguments: '{}',
      });
      emit('chat', start('tests'));
      emit('chat', start('status'));
      emit('chat', { kind: 'toolDelta', callId: 'tests', text: 'RUN v3\n' });
      emit('chat', { kind: 'toolDelta', callId: 'status', text: 'clean\n' });
      // A command that is over at once never opens.
      emit('chat', {
        kind: 'toolEnd',
        callId: 'status',
        name: 'bash',
        status: 'ok',
        result: 'clean',
        changes: [],
      });
      expect(tools().map((tool) => [tool.output, tool.live])).toEqual([
        ['RUN v3\n', false],
        ['clean', false],
      ]);
      vi.advanceTimersByTime(1_000);
      expect(tools().map((tool) => tool.live)).toEqual([true, false]);

      const line = `${'x'.repeat(99)}\n`;
      emit('chat', { kind: 'toolDelta', callId: 'tests', text: line.repeat(999) + 'done\n' });
      emit('chat', start('next'));
      const output = tools()[0].output;
      expect(output.length).toBeLessThanOrEqual(64_000);
      expect(output.startsWith(line)).toBe(true);
      expect(output.endsWith('done\n')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers to continue a turn that was cut off, until the chat goes on', async () => {
    const reply = { id: 'reply', sessionId: 'chat', role: 'assistant' } as Message;
    await workspace.resumeRunningTurns();
    expect(workspace.interruptedFor('chat')).toBe(false);

    // The machine slept while the reply was on its way.
    emit('chat', { kind: 'interrupted', message: reply });
    expect(workspace.interruptedFor('chat')).toBe(true);
    vi.mocked(api.listSessions).mockResolvedValue([{ ...session('chat'), interrupted: true }]);
    finishTurn(true);
    await vi.waitFor(() => expect(workspace.isStreaming('chat')).toBe(false));
    expect(workspace.interruptedFor('chat')).toBe(true);

    const sent = vi.spyOn(api, 'sendMessage').mockReturnValue(new Promise(() => {}));
    await Promise.race([workspace.continueSession('chat'), Promise.resolve()]);

    expect(sent.mock.calls[0][0]).toMatchObject({ sessionId: 'chat', content: '', resume: true });
    expect(workspace.interruptedFor('chat')).toBe(false);
  });

  it('reads the files of the project again whenever the turn reports changes', async () => {
    await workspace.resumeRunningTurns();
    const changes = [{ path: 'src/a.ts', additions: 1, deletions: 0, status: 'M' }];

    emit('chat', { kind: 'changes', changes });
    // Reported again before the first pass is done: one more pass, not two.
    emit('subagent', { kind: 'changes', changes });
    emit('chat', { kind: 'changes', changes });

    expect(workspace.changesFor('chat')).toEqual(changes);
    await vi.waitFor(() => expect(followWorkingTree).toHaveBeenCalledTimes(2));
    expect(followWorkingTree).toHaveBeenCalledWith('project');
    expect(loadWorkspaceEntries).toHaveBeenCalledWith('project', true);
    expect(loadWorkspaceEntries).toHaveBeenCalledTimes(2);
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
      modelChoices: [],
    });
    await workspace.resumeRunningTurns();
    expect(workspace.sessionAttention('chat')).toBe('question');

    await workspace.resolveQuestion('q1', null);
    // The backend can still list it until the waiting tool call wakes up.
    await workspace.resumeRunningTurns();
    expect(workspace.sessionAttention('chat')).toBeNull();
  });

  it('restores an open model choice until the user picks a model', async () => {
    vi.spyOn(api, 'resolveModelChoice').mockResolvedValue();
    vi.mocked(api.listRunningTurns).mockResolvedValue({
      sessionIds: [],
      permissions: [],
      questions: [],
      modelChoices: [
        {
          sessionId: 'chat',
          event: {
            kind: 'modelChoiceRequest',
            requestId: 'm1',
            query: 'flash',
            candidates: ['google/gemini-flash'],
          },
        },
      ],
    });
    await workspace.resumeRunningTurns();
    expect(workspace.sessionAttention('chat')).toBe('question');

    await workspace.resolveModelChoice('m1', 'google/gemini-flash');
    expect(api.resolveModelChoice).toHaveBeenCalledWith('m1', 'google/gemini-flash');
    await workspace.resumeRunningTurns();
    expect(workspace.sessionAttention('chat')).toBeNull();
  });
});

describe('WorkspaceService session lifecycle', () => {
  let workspace: WorkspaceService;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        WorkspaceService,
        { provide: SettingsService, useValue: { settings: signal(null) } },
        { provide: SoundService, useValue: { play: vi.fn() } },
        { provide: TranslocoService, useValue: { translate: (key: string) => key } },
        { provide: ProcessService, useValue: { processes: signal([]) } },
        { provide: GitService, useValue: { followWorkingTree: async () => {} } },
        {
          provide: WorkspaceEditorService,
          useValue: { loadWorkspaceEntries: async () => {}, activeFileFor: () => null },
        },
      ],
    });
    workspace = TestBed.inject(WorkspaceService);
    vi.spyOn(api, 'listProjects').mockResolvedValue([]);
    vi.spyOn(api, 'listSessions').mockResolvedValue([session('chat'), session('other')]);
    vi.spyOn(api, 'listSubSessionsForProject').mockResolvedValue([
      session('subagent', 'chat'),
      session('nested', 'subagent'),
    ]);
    vi.spyOn(api, 'getSpend').mockRejectedValue(new Error('no spend'));
    await workspace.reloadSessions('project');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forgets the subagent sessions of a deleted chat', async () => {
    vi.spyOn(api, 'deleteSession').mockResolvedValue();
    vi.mocked(api.listSessions).mockResolvedValue([session('other')]);
    vi.mocked(api.listSubSessionsForProject).mockResolvedValue([]);

    await workspace.deleteSession('chat');

    expect(workspace.session('chat')).toBeNull();
    expect(workspace.session('subagent')).toBeNull();
    expect(workspace.session('nested')).toBeNull();
    expect(workspace.session('other')).not.toBeNull();
    expect(workspace.subAgentsFor('chat')).toEqual([]);
  });

  it('stops the turn of the session the user is looking at', async () => {
    vi.spyOn(api, 'stopGeneration').mockResolvedValue();

    await workspace.stop('subagent');

    expect(api.stopGeneration).toHaveBeenCalledWith('subagent');
  });

  it('shows a refused revert as the session error and keeps the transcript', async () => {
    const prompt: Message = {
      id: 'prompt',
      sessionId: 'chat',
      seq: 0,
      role: 'user',
      content: 'Fix the tests',
      reasoning: '',
      model: null,
      provider: null,
      cost: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      createdAt: 0,
      toolCalls: [],
      toolCallId: null,
      toolName: null,
      status: null,
      changes: [],
      baseCommit: null,
      attachments: [],
      mentions: [],
      context: '',
      durationMs: 0,
    };
    vi.spyOn(api, 'listMessages').mockResolvedValue([prompt]);
    vi.spyOn(api, 'revertToMessage').mockRejectedValue('Stop the running turn before reverting.');
    await workspace.loadMessages('chat', true);

    expect(await workspace.revertToMessage('prompt', true)).toBeNull();

    expect(workspace.errorFor('chat')).toBe('Stop the running turn before reverting.');
    expect(workspace.messagesFor('chat')).toEqual([prompt]);
  });
});

describe('WorkspaceService chats waiting elsewhere', () => {
  let workspace: WorkspaceService;

  function waiting(): string[] {
    return workspace.waitingElsewhere().map((chat) => `${chat.session.id}:${chat.kind}`);
  }

  /** Opens a chat and lets its background loading settle. */
  async function show(sessionId: string): Promise<void> {
    workspace.showWaitingChat(sessionId);
    await vi.waitFor(() => expect(api.getSpend).toHaveBeenLastCalledWith(sessionId));
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        WorkspaceService,
        { provide: SettingsService, useValue: { settings: signal(null) } },
        { provide: SoundService, useValue: { play: vi.fn() } },
        { provide: TranslocoService, useValue: { translate: (key: string) => key } },
        { provide: ProcessService, useValue: { processes: signal([]) } },
        {
          provide: GitService,
          useValue: {
            resetView: () => {},
            loadInfo: async () => {},
            followWorkingTree: async () => {},
          },
        },
        {
          provide: WorkspaceEditorService,
          useValue: { loadWorkspaceEntries: async () => {}, activeFileFor: () => null },
        },
      ],
    });
    workspace = TestBed.inject(WorkspaceService);
    const subagent = session('subagent', 'chat');
    vi.spyOn(api, 'listProjects').mockResolvedValue([]);
    vi.spyOn(api, 'listSessions').mockResolvedValue([session('chat'), session('other')]);
    vi.spyOn(api, 'listSubSessionsForProject').mockResolvedValue([subagent]);
    vi.spyOn(api, 'listSubSessions').mockImplementation(async (sessionId) =>
      sessionId === 'chat' ? [subagent] : [],
    );
    vi.spyOn(api, 'listMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getSpend').mockRejectedValue(new Error('no spend'));
    vi.spyOn(api, 'getSessionChanges').mockResolvedValue([]);
    vi.spyOn(api, 'getProjectRules').mockResolvedValue([]);
    vi.spyOn(api, 'listRunningTurns').mockResolvedValue({
      sessionIds: [],
      permissions: [{ sessionId: 'subagent', event: permission('p1') }],
      questions: [
        { sessionId: 'chat', event: question('q1') },
        { sessionId: 'other', event: question('q2') },
      ],
      modelChoices: [],
    });
    await workspace.reloadSessions('project');
    await workspace.resumeRunningTurns();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('lists each waiting chat once under its root session, permissions first', () => {
    expect(waiting()).toEqual(['chat:permission', 'other:question']);
  });

  it('leaves out the chat on screen', async () => {
    await show('chat');
    expect(waiting()).toEqual(['other:question']);

    await show('other');
    expect(waiting()).toEqual(['chat:permission']);
  });

  it('drops a dismissed chat until it raises a new prompt', async () => {
    workspace.dismissWaitingChat('chat');
    expect(waiting()).toEqual(['other:question']);

    vi.mocked(api.listRunningTurns).mockResolvedValue({
      sessionIds: [],
      permissions: [],
      questions: [{ sessionId: 'subagent', event: question('q3') }],
      modelChoices: [],
    });
    await workspace.resumeRunningTurns();

    expect(waiting()).toEqual(['other:question', 'chat:question']);
  });

  it('points back to the main view while a sub-agent hides its prompts', async () => {
    await show('chat');
    workspace.viewAgent('chat', 'subagent');
    // The sub-agent's own permission is on screen, the main chat's question is not.
    expect(waiting()).toEqual(['chat:question', 'other:question']);

    workspace.showWaitingChat('chat');

    expect(workspace.activeAgentId()).toBe('chat');
    expect(waiting()).toEqual(['other:question']);
  });
});

describe('WorkspaceService project order', () => {
  function project(id: string, patch: Partial<Project> = {}): Project {
    return {
      id,
      path: `/code/${id}`,
      name: id,
      createdAt: 0,
      lastOpenedAt: 0,
      sessionCount: 0,
      totalCost: 0,
      color: null,
      icon: null,
      iconImage: null,
      ...patch,
    };
  }

  function create(): WorkspaceService {
    TestBed.configureTestingModule({
      providers: [
        WorkspaceService,
        { provide: SettingsService, useValue: { settings: signal(null) } },
        { provide: SoundService, useValue: { play: vi.fn() } },
        { provide: TranslocoService, useValue: { translate: (key: string) => key } },
        { provide: ProcessService, useValue: { processes: signal([]) } },
        { provide: GitService, useValue: {} },
        { provide: WorkspaceEditorService, useValue: {} },
      ],
    });
    return TestBed.inject(WorkspaceService);
  }

  function order(workspace: WorkspaceService): string[] {
    return workspace.projects().map((entry) => entry.id);
  }

  beforeEach(() => {
    // The backend answers newest-opened first, which is not what the sidebar shows.
    vi.spyOn(api, 'listProjects').mockResolvedValue([
      project('zebra', { lastOpenedAt: 300, sessionCount: 1 }),
      project('mango', { lastOpenedAt: 200, sessionCount: 5 }),
      project('apple', { lastOpenedAt: 100, sessionCount: 2 }),
    ]);
    vi.spyOn(api, 'listSessions').mockImplementation(async (projectId) =>
      projectId === 'apple' ? [{ ...session('chat'), projectId, updatedAt: 900 }] : [],
    );
    vi.spyOn(api, 'listSubSessionsForProject').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('lists projects alphabetically by default', async () => {
    const workspace = create();
    await workspace.reloadProjects();

    expect(workspace.projectSort()).toBe('name');
    expect(order(workspace)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('orders by session count', async () => {
    const workspace = create();
    await workspace.reloadProjects();

    workspace.setProjectSort('sessions');

    expect(order(workspace)).toEqual(['mango', 'apple', 'zebra']);
  });

  it('orders by last activity, counting the newest session of a project', async () => {
    const workspace = create();
    await workspace.reloadProjects();

    workspace.setProjectSort('activity');

    // apple was opened longest ago but holds the most recently updated chat.
    expect(order(workspace)).toEqual(['apple', 'zebra', 'mango']);
  });

  it('remembers the chosen order and ignores a stored value it does not know', async () => {
    create().setProjectSort('sessions');
    TestBed.resetTestingModule();
    expect(create().projectSort()).toBe('sessions');

    localStorage.setItem('pumr.projectSort', 'random');
    TestBed.resetTestingModule();
    expect(create().projectSort()).toBe('name');
  });
});
