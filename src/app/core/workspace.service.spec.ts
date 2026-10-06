import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { Channel } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { GitService } from './git.service';
import { MessageQueueService } from './message-queue.service';
import {
  Message,
  PermissionRequestEvent,
  Project,
  ProjectRule,
  QuestionRequestEvent,
  RoutedEvent,
  SendMessageArgs,
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

  it('says which MCP server a turn waits for and which ones it has to do without', async () => {
    const issues = ["MCP server 'codegraph' stopped during initialize: exit status: 127"];
    await workspace.resumeRunningTurns();

    emit('chat', { kind: 'mcpStarting', server: 'codegraph' });
    expect(workspace.mcpStartingFor('chat')).toBe('codegraph');
    expect(workspace.mcpIssuesFor('chat')).toEqual([]);

    emit('chat', { kind: 'mcpReady', issues });
    expect(workspace.mcpStartingFor('chat')).toBeNull();
    expect(workspace.mcpIssuesFor('chat')).toEqual(issues);

    // Stopped while the next server starts: nothing is waited for anymore, and
    // what was missing stays on screen until the chat goes on.
    emit('chat', { kind: 'mcpStarting', server: 'slow' });
    finishTurn(true);
    await vi.waitFor(() => expect(workspace.isStreaming('chat')).toBe(false));
    expect(workspace.mcpStartingFor('chat')).toBeNull();
    expect(workspace.mcpIssuesFor('chat')).toEqual(issues);

    vi.spyOn(api, 'sendMessage').mockReturnValue(new Promise(() => {}));
    await Promise.race([workspace.continueSession('chat'), Promise.resolve()]);
    expect(workspace.mcpIssuesFor('chat')).toEqual([]);
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

  it('takes the notices of a turn back with the prompt it is reverted to', async () => {
    const prompt = { id: 'prompt', sessionId: 'chat', role: 'user', content: 'Go on' } as Message;
    // The turn stopped at the tool limit; another one was cut off.
    vi.mocked(api.listSessions).mockResolvedValue([
      { ...session('chat'), limitReached: true, interrupted: true },
    ]);
    await workspace.reloadSessions('project');
    const listed = vi.spyOn(api, 'listMessages').mockResolvedValue([prompt]);
    await workspace.loadMessages('chat', true);
    expect(workspace.limitReachedFor('chat')).toBe(true);
    listed.mockResolvedValue([]);
    vi.spyOn(api, 'getSessionChanges').mockResolvedValue([]);
    vi.spyOn(api, 'revertToMessage').mockResolvedValue({ prompt: 'Go on', restoredFiles: [] });

    await workspace.revertToMessage('prompt', true);

    expect(workspace.limitReachedFor('chat')).toBe(false);
    expect(workspace.interruptedFor('chat')).toBe(false);
    expect(workspace.pendingDraft()).toBe('Go on');
  });
});

describe('WorkspaceService sending a prompt', () => {
  let workspace: WorkspaceService;
  let queue: MessageQueueService;
  /** What the backend has stored of the chat. */
  let stored: Message[];

  function message(id: string, role: Message['role'], content = ''): Message {
    return { id, sessionId: 'chat', role, content, toolCalls: [] } as unknown as Message;
  }

  function prompt(content: string): SendMessageArgs {
    return { sessionId: 'chat', content, model: 'model' };
  }

  /** A backend that stores the prompt and then lets `turn` report how it went. */
  function taking(turn: (emit: (event: StreamEvent) => void) => void): void {
    vi.spyOn(api, 'sendMessage').mockImplementation(async (args, channel) => {
      stored.push(message(`stored-${stored.length}`, 'user', args.content));
      turn((event) => channel.onmessage({ sessionId: args.sessionId, event }));
      return message('reply', 'assistant');
    });
  }

  /** Lets a prompt sent from the queue, which nobody awaits, run to its end. */
  async function idle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await vi.waitFor(() => expect(workspace.isStreaming('chat')).toBe(false));
  }

  beforeEach(async () => {
    // `new Channel()` registers its callback with the Tauri runtime.
    let callbackId = 0;
    Object.assign(window, {
      __TAURI_INTERNALS__: { transformCallback: () => ++callbackId, unregisterCallback: () => {} },
    });
    TestBed.configureTestingModule({
      providers: [
        WorkspaceService,
        { provide: SettingsService, useValue: { settings: signal(null) } },
        { provide: SoundService, useValue: { play: vi.fn() } },
        { provide: TranslocoService, useValue: { translate: (key: string) => key } },
        { provide: ProcessService, useValue: { processes: signal([]) } },
        {
          provide: GitService,
          useValue: { loadInfo: async () => {}, followWorkingTree: async () => {} },
        },
        {
          provide: WorkspaceEditorService,
          useValue: { loadWorkspaceEntries: async () => {}, activeFileFor: () => null },
        },
      ],
    });
    workspace = TestBed.inject(WorkspaceService);
    queue = TestBed.inject(MessageQueueService);
    stored = [message('earlier', 'user', 'An earlier prompt')];
    vi.spyOn(api, 'listProjects').mockResolvedValue([]);
    vi.spyOn(api, 'listSessions').mockResolvedValue([session('chat'), session('other')]);
    vi.spyOn(api, 'listSubSessionsForProject').mockResolvedValue([]);
    vi.spyOn(api, 'listSubSessions').mockResolvedValue([]);
    vi.spyOn(api, 'listMessages').mockImplementation(async () => [...stored]);
    vi.spyOn(api, 'getSpend').mockRejectedValue(new Error('no spend'));
    vi.spyOn(api, 'getSessionChanges').mockResolvedValue([]);
    vi.spyOn(api, 'getProjectRules').mockImplementation(async (_project, sessionId) => [
      { path: `${sessionId}/AGENTS.md`, scope: 'project', content: '' },
    ]);
    vi.spyOn(api, 'listRunningTurns').mockResolvedValue({
      sessionIds: [],
      permissions: [],
      questions: [],
      modelChoices: [],
    });
    await workspace.reloadSessions('project');
    await workspace.loadMessages('chat');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('says so when the backend turns the prompt down before storing it', async () => {
    // As for a model without an API key: no turn, no event, only the refusal.
    vi.spyOn(api, 'sendMessage').mockRejectedValue('No API key for this model.');

    expect(await workspace.send(prompt('Fix the tests'))).toBe(false);

    expect(workspace.errorFor('chat')).toBe('No API key for this model.');
    expect(workspace.messagesFor('chat').map((entry) => entry.id)).toEqual(['earlier']);
    expect(workspace.isStreaming('chat')).toBe(false);
  });

  it('takes the prompt out of the chat when it cannot even be read again', async () => {
    vi.spyOn(api, 'sendMessage').mockRejectedValue('Project folder no longer exists: /code/app');
    vi.mocked(api.listMessages).mockRejectedValue(new Error('database is locked'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await workspace.send(prompt('Fix the tests'))).toBe(false);

    expect(workspace.messagesFor('chat').map((entry) => entry.id)).toEqual(['earlier']);
  });

  it('counts a prompt as taken when its turn fails after the reply began', async () => {
    taking((emit) => {
      emit({ kind: 'started', message: message('reply', 'assistant') });
      throw 'The provider is overloaded.';
    });

    expect(await workspace.send(prompt('Fix the tests'))).toBe(true);

    expect(workspace.errorFor('chat')).toBe('The provider is overloaded.');
    expect(workspace.messagesFor('chat').map((entry) => entry.content)).toEqual([
      'An earlier prompt',
      'Fix the tests',
    ]);
  });

  it('counts a prompt as taken when its turn fails before a reply began', async () => {
    taking((emit) => {
      emit({ kind: 'error', message: 'The history could not be compacted.' });
      throw 'The history could not be compacted.';
    });

    expect(await workspace.send(prompt('Fix the tests'))).toBe(true);
  });

  it('stops the queue at a prompt the backend turns down and keeps it queued', async () => {
    const first = prompt('First in the queue');
    const second = prompt('Second in the queue');
    queue.enqueue(first);
    queue.enqueue(second);
    // The turn before them ends; from then on the backend refuses.
    const sent = vi
      .spyOn(api, 'sendMessage')
      .mockResolvedValueOnce(message('reply', 'assistant'))
      .mockRejectedValue('Project folder no longer exists: /code/app');

    expect(await workspace.send(prompt('Sent by hand'))).toBe(true);
    await idle();

    expect(sent.mock.calls.map(([args]) => args.content)).toEqual([
      'Sent by hand',
      'First in the queue',
    ]);
    expect(queue.forSession('chat')).toEqual([first, second]);
    expect(queue.first('chat')).toBe(first);
    expect(workspace.errorFor('chat')).toBe('Project folder no longer exists: /code/app');
  });

  it('goes on with the queue after a turn that failed on its way', async () => {
    queue.enqueue(prompt('Queued'));
    const sent = vi
      .spyOn(api, 'sendMessage')
      .mockImplementationOnce(async (args, channel) => {
        channel.onmessage({
          sessionId: args.sessionId,
          event: { kind: 'error', message: 'The provider is overloaded.' },
        });
        throw 'The provider is overloaded.';
      })
      .mockResolvedValue(message('reply', 'assistant'));

    await workspace.send(prompt('Sent by hand'));
    await idle();

    expect(sent.mock.calls.map(([args]) => args.content)).toEqual(['Sent by hand', 'Queued']);
    expect(queue.forSession('chat')).toEqual([]);
  });

  describe('and the rules of the chat on screen', () => {
    const rulesOf = (sessionId: string) => [
      { path: `${sessionId}/AGENTS.md`, scope: 'project', content: '' },
    ];

    it('are not replaced when a turn ends in another chat', async () => {
      workspace.openTab('other');
      await vi.waitFor(() => expect(workspace.rules()).toEqual(rulesOf('other')));
      vi.spyOn(api, 'sendMessage').mockResolvedValue(message('reply', 'assistant'));

      await workspace.send(prompt('Fix the tests'));

      expect(api.getProjectRules).toHaveBeenCalledWith('project', 'chat');
      expect(workspace.rules()).toEqual(rulesOf('other'));
    });

    it('are not replaced by the slow answer for the chat that was shown before', async () => {
      let answer!: (rules: ProjectRule[]) => void;
      vi.mocked(api.getProjectRules).mockImplementation((_project, sessionId) =>
        sessionId === 'chat'
          ? new Promise((resolve) => (answer = resolve))
          : Promise.resolve(rulesOf('other')),
      );
      workspace.openTab('chat');
      await vi.waitFor(() => expect(answer).toBeDefined());
      workspace.openTab('other');
      await vi.waitFor(() => expect(workspace.rules()).toEqual(rulesOf('other')));

      answer(rulesOf('chat'));
      await new Promise((resolve) => setTimeout(resolve));

      expect(workspace.rules()).toEqual(rulesOf('other'));
    });
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

describe('WorkspaceService browsed project', () => {
  let resetView: ReturnType<typeof vi.fn>;
  let projects: Project[];

  function project(id: string): Project {
    return {
      id,
      path: `/code/${id}`,
      name: id,
      createdAt: 0,
      lastOpenedAt: 0,
      sessionCount: 1,
      totalCost: 0,
      color: null,
      icon: null,
      iconImage: null,
    };
  }

  function create(): WorkspaceService {
    resetView = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        WorkspaceService,
        { provide: SettingsService, useValue: { settings: signal(null) } },
        { provide: SoundService, useValue: { play: vi.fn() } },
        { provide: TranslocoService, useValue: { translate: (key: string) => key } },
        {
          provide: ProcessService,
          useValue: { processes: signal([]), refresh: async () => {}, startPolling: () => {} },
        },
        { provide: GitService, useValue: { resetView, loadInfo: async () => {} } },
        {
          provide: WorkspaceEditorService,
          useValue: { loadWorkspaceEntries: async () => {}, activeFileFor: () => null },
        },
      ],
    });
    return TestBed.inject(WorkspaceService);
  }

  /** Starts the app with the chat of `projectId` on screen. */
  async function start(projectId: string): Promise<WorkspaceService> {
    localStorage.setItem('pumr.tabs', JSON.stringify([`${projectId}-chat`]));
    localStorage.setItem('pumr.activeTab', `${projectId}-chat`);
    const workspace = create();
    await workspace.init();
    return workspace;
  }

  beforeEach(() => {
    projects = [project('apple'), project('mango')];
    vi.spyOn(api, 'listProjects').mockImplementation(async () => projects);
    vi.spyOn(api, 'listSessions').mockImplementation(async (projectId) => [
      { ...session(`${projectId}-chat`), projectId },
    ]);
    vi.spyOn(api, 'listSubSessionsForProject').mockResolvedValue([]);
    vi.spyOn(api, 'listSubSessions').mockResolvedValue([]);
    vi.spyOn(api, 'listMessages').mockResolvedValue([]);
    vi.spyOn(api, 'getSpend').mockRejectedValue(new Error('no spend'));
    vi.spyOn(api, 'getSessionChanges').mockResolvedValue([]);
    vi.spyOn(api, 'getProjectRules').mockResolvedValue([]);
    vi.spyOn(api, 'listRunningTurns').mockResolvedValue({
      sessionIds: [],
      permissions: [],
      questions: [],
      modelChoices: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('starts on the project of the session on screen', async () => {
    const workspace = await start('mango');

    expect(workspace.browseProject()?.id).toBe('mango');
  });

  it('stays on the chosen project when a session of another one opens', async () => {
    const workspace = await start('mango');

    workspace.setBrowseProject('apple');
    workspace.openTab('mango-chat');

    expect(workspace.activeProject()?.id).toBe('mango');
    expect(workspace.browseProject()?.id).toBe('apple');
    // Only the choice starts a fresh git view, a session coming on screen does not.
    expect(resetView.mock.calls).toEqual([['apple']]);
  });

  it('remembers the choice over the session on screen', async () => {
    (await start('mango')).setBrowseProject('apple');
    TestBed.resetTestingModule();

    expect((await start('mango')).browseProject()?.id).toBe('apple');
  });

  it('moves on when the chosen project is removed', async () => {
    const workspace = await start('mango');
    vi.spyOn(api, 'removeProject').mockImplementation(async () => {
      projects = [project('apple')];
    });

    await workspace.removeProject('mango');

    expect(workspace.browseProject()?.id).toBe('apple');
  });

  it('attributes the changes of the active session to its own project only', async () => {
    const workspace = await start('mango');

    expect(workspace.sessionIn('mango')?.id).toBe('mango-chat');
    expect(workspace.sessionIn('apple')).toBeNull();
  });
});
