import { WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { api } from '../core/api';
import { MessageQueueService } from '../core/message-queue.service';
import {
  Mention,
  Message,
  MessageAttachment,
  Mode,
  ModelInfo,
  WorkspaceEntry,
} from '../core/models';
import { ModelsService } from '../core/models.service';
import { FALLBACK_SETTINGS, SettingsService } from '../core/settings.service';
import { SideQuestion, SideQuestionService } from '../core/side-question.service';
import { ComposerInsert, WorkspaceService } from '../core/workspace.service';
import { Composer } from './composer';

function prompt(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, attachments: [], mentions: [], toolCalls: [] } as unknown as Message;
}

/** What the specs use of the composer's protected and private members. */
interface ComposerInternals {
  attachments: () => MessageAttachment[];
  mentionItems: () => { value: string }[];
  selectMention: (item: Mention & { sublabel: string | null }) => void;
  addFiles: (files: File[]) => Promise<void>;
  removeAttachment: (id: string) => void;
}

describe('Composer', () => {
  let fixture: ComponentFixture<Composer>;
  let streaming: ReturnType<typeof signal<boolean>>;
  let messages: ReturnType<typeof signal<Message[]>>;
  let stop: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  let ask: ReturnType<typeof vi.fn>;
  let dismiss: ReturnType<typeof vi.fn>;
  let sideQuestion: ReturnType<typeof signal<SideQuestion | null>>;
  let updateSession: ReturnType<typeof vi.fn>;
  let models: ReturnType<typeof signal<ModelInfo[]>>;
  let modes: ReturnType<typeof signal<Mode[]>>;
  let activeAgent: WritableSignal<{ id: string; model: string }>;
  let activeProject: WritableSignal<{ id: string } | null>;
  let pendingDraft: WritableSignal<string | null>;
  let pendingInsert: WritableSignal<ComposerInsert | null>;
  /** What the workspace keeps of each session's chat box while it is off screen. */
  let drafts: Record<string, string>;
  let kept: Record<string, MessageAttachment[]>;

  beforeEach(() => {
    streaming = signal(false);
    messages = signal<Message[]>([]);
    stop = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(true);
    ask = vi.fn().mockResolvedValue(undefined);
    sideQuestion = signal<SideQuestion | null>(null);
    dismiss = vi.fn(() => sideQuestion.set(null));
    updateSession = vi.fn().mockResolvedValue(undefined);
    models = signal<ModelInfo[]>([]);
    modes = signal<Mode[]>([]);
    activeAgent = signal({ id: 'session-1', model: 'model-x' });
    activeProject = signal<{ id: string } | null>(null);
    pendingDraft = signal<string | null>(null);
    pendingInsert = signal<ComposerInsert | null>(null);
    drafts = {};
    kept = {};
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WorkspaceService,
          useValue: {
            activeAgent,
            activeSession: signal({ id: 'session-1' }),
            activeProject,
            isStreaming: () => streaming(),
            isHandover: () => false,
            messagesFor: () => messages(),
            contextUsage: signal({}),
            pendingDraft,
            consumeDraft: () => pendingDraft.set(null),
            pendingComposerInsert: pendingInsert,
            consumeComposerInsert: () => pendingInsert.set(null),
            composerDraftFor: (id: string) => drafts[id] ?? '',
            composerAttachmentsFor: (id: string) => kept[id] ?? [],
            // Like the real ones, they keep nothing for an empty chat box.
            setComposerDraft: (id: string, text: string) => {
              drafts = { ...drafts, [id]: text };
              if (!text) {
                delete drafts[id];
              }
            },
            setComposerAttachments: (id: string, list: MessageAttachment[]) => {
              kept = { ...kept, [id]: list };
              if (list.length === 0) {
                delete kept[id];
              }
            },
            clearComposerDraft: (id: string) => delete drafts[id],
            clearComposerAttachments: (id: string) => delete kept[id],
            composerFocusNonce: signal(0),
            stop,
            send,
            updateSession,
          },
        },
        {
          provide: SideQuestionService,
          useValue: { ask, dismiss, forSession: () => sideQuestion() },
        },
        {
          provide: SettingsService,
          useValue: {
            settings: signal({
              ...FALLBACK_SETTINGS,
              userSystemPrompts: [
                { id: 'code-review', name: 'Code Review', prompt: 'Review the changes.' },
                { id: 'custom-1', name: 'Prüf-Notizen 2', prompt: 'Write notes.' },
                { id: 'custom-2', name: 'Not written yet', prompt: '  ' },
              ],
            }),
            modes,
            patch: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ModelsService,
          useValue: {
            loadProviders: vi.fn().mockResolvedValue(undefined),
            loadEndpoints: vi.fn().mockResolvedValue(undefined),
            byId: (id: string) => models().find((entry) => entry.id === id),
            endpoints: signal({}),
            endpointsLoading: signal({}),
            models,
          },
        },
        { provide: TranslocoService, useValue: { translate: (key: string) => key } },
      ],
    });
    TestBed.overrideComponent(Composer, {
      set: {
        imports: [],
        template: `
          <div
            #editor
            contenteditable="true"
            (input)="onEditorInput()"
            (keydown)="onKeydown($event)"
          ></div>
        `,
      },
    });
    fixture = TestBed.createComponent(Composer);
    fixture.detectChanges();
  });

  function editor(): HTMLDivElement {
    return (fixture.nativeElement as HTMLElement).querySelector('div')!;
  }

  function press(key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    editor().dispatchEvent(event);
    return event;
  }

  function type(text: string): void {
    editor().textContent = text;
    editor().dispatchEvent(new Event('input'));
  }

  function model(id: string, name: string, supportsReasoning = true): ModelInfo {
    return {
      id,
      name,
      source: 'openrouter',
      contextLength: 200_000,
      promptPricePerM: 3,
      completionPricePerM: 15,
      supportsReasoning,
    } as ModelInfo;
  }

  it('stops a running turn on Escape', () => {
    streaming.set(true);
    const event = press('Escape');
    expect(stop).toHaveBeenCalledWith('session-1');
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Escape alone while idle', () => {
    press('Escape');
    expect(stop).not.toHaveBeenCalled();
  });

  it('recalls the last prompt with ArrowUp in an empty composer', () => {
    messages.set([
      prompt('u1', 'user', 'first prompt'),
      prompt('a1', 'assistant', 'answer'),
      prompt('u2', 'user', 'second prompt'),
      prompt('a2', 'assistant', 'answer'),
    ]);
    const event = press('ArrowUp');
    expect(editor().textContent).toBe('second prompt');
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps a draft instead of recalling over it', () => {
    messages.set([prompt('u1', 'user', 'first prompt')]);
    editor().textContent = 'my draft';
    editor().dispatchEvent(new Event('input'));
    const event = press('ArrowUp');
    expect(editor().textContent).toBe('my draft');
    expect(event.defaultPrevented).toBe(false);
  });

  it('completes a slash command on Enter instead of sending it', () => {
    type('/b');
    const event = press('Enter');
    expect(event.defaultPrevented).toBe(true);
    expect(editor().textContent).toBe('/btw ');
    expect(send).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it('sends a slash that starts no command', () => {
    type('/usr/bin is on the path');
    press('Enter');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', content: '/usr/bin is on the path' }),
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks a /btw draft as a side question, also while a turn runs', () => {
    streaming.set(true);
    type('/btw what changed so far?');
    press('Enter');
    expect(ask).toHaveBeenCalledWith('session-1', 'what changed so far?', 'model-x');
    expect(send).not.toHaveBeenCalled();
    expect(editor().textContent).toBe('');
  });

  it('keeps /btw in the chat box until it has a question', () => {
    type('/btw ');
    press('Enter');
    expect(ask).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(editor().textContent).toBe('/btw ');
  });

  it('closes a side answer on Escape before stopping the turn', () => {
    streaming.set(true);
    sideQuestion.set({ id: 1, question: 'why?', answer: 'because', status: 'done', error: null });

    expect(press('Escape').defaultPrevented).toBe(true);
    expect(dismiss).toHaveBeenCalledWith('session-1');
    expect(stop).not.toHaveBeenCalled();

    press('Escape');
    expect(stop).toHaveBeenCalledWith('session-1');
  });

  it('calls a prompt once its whole name is typed and completes the name before that', () => {
    type('/co');
    press('Enter');
    expect(editor().textContent).toBe('/code-review ');
    expect(send).not.toHaveBeenCalled();

    type('/code-review');
    press('Enter');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        content: '/code-review',
        promptId: 'code-review',
      }),
    );
  });

  it('sends what follows the name of a prompt along with it', () => {
    type('/Prüf-Notizen-2 for the login change');
    press('Enter');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '/Prüf-Notizen-2 for the login change',
        promptId: 'custom-1',
      }),
    );
  });

  it('calls no prompt for a prompt without text or for an ordinary message', () => {
    type('/not-written-yet');
    press('Enter');
    type('please run /code-review later');
    press('Enter');
    expect(send).toHaveBeenCalledTimes(2);
    for (const [args] of send.mock.calls) {
      expect(args).not.toHaveProperty('promptId');
    }
  });

  it('sets the effort typed after /effort', () => {
    models.set([model('model-x', 'Model X')]);
    type('/effort hi');
    expect(press('Enter').defaultPrevented).toBe(true);
    expect(updateSession).toHaveBeenCalledWith({ sessionId: 'session-1', reasoningEffort: 'high' });
    expect(editor().textContent).toBe('');
    expect(send).not.toHaveBeenCalled();
  });

  it('starts /effort on the level in effect and moves from there with the arrows', () => {
    models.set([model('model-x', 'Model X')]);
    type('/eff');
    press('Enter');
    expect(editor().textContent).toBe('/effort ');

    // Medium is in effect: one step up is low, wrapping around is not needed.
    press('ArrowUp');
    press('Enter');
    expect(updateSession).toHaveBeenCalledWith({ sessionId: 'session-1', reasoningEffort: 'low' });
  });

  it('keeps /effort in the chat box for a model without reasoning levels', () => {
    models.set([model('model-x', 'Model X', false)]);
    type('/effort high');
    press('Enter');
    expect(updateSession).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(editor().textContent).toBe('/effort high');
  });

  it('switches to the model that matches the words after /model', () => {
    models.set([
      model('model-x', 'Model X'),
      model('anthropic/claude-opus-5', 'Claude Opus 5'),
      model('anthropic/claude-sonnet-5', 'Claude Sonnet 5'),
    ]);
    type('/model claude son');
    press('Enter');
    expect(updateSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      model: 'anthropic/claude-sonnet-5',
      provider: '',
    });
    expect(editor().textContent).toBe('');
  });

  it('switches to the mode typed after /mode', () => {
    const mode = (id: string, name: string, planOnly = false) =>
      ({ id, name, description: `${name} mode`, planOnly }) as Mode;
    modes.set([mode('coding', 'Coding'), mode('planning', 'Planning', true)]);
    type('/mo');
    press('Enter');
    expect(editor().textContent).toBe('/mode ');

    type('/mode plan');
    press('Enter');
    expect(updateSession).toHaveBeenCalledWith({ sessionId: 'session-1', modeId: 'planning' });
    expect(editor().textContent).toBe('');
    expect(send).not.toHaveBeenCalled();
  });

  it('routes the model to the provider picked with /provider', async () => {
    type('/provider price');
    press('Enter');
    expect(editor().textContent).toBe('');
    // The choice is remembered for the model before the session is updated.
    await vi.waitFor(() =>
      expect(updateSession).toHaveBeenCalledWith({
        sessionId: 'session-1',
        provider: 'auto:price',
      }),
    );
  });

  it('never sends the line of a picker command as a prompt', () => {
    models.set([model('model-x', 'Model X')]);
    type('/model no such model');
    press('Enter');
    expect(send).not.toHaveBeenCalled();

    // Escape closes the choices; Enter brings them back instead of sending.
    press('Escape');
    press('Enter');
    expect(send).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(editor().textContent).toBe('/model no such model');
  });

  describe('/revert', () => {
    let reverted: Message[];

    beforeEach(() => {
      reverted = [];
      fixture.componentInstance.revertRequested.subscribe((message) => reverted.push(message));
      messages.set([
        prompt('u1', 'user', 'first prompt'),
        prompt('a1', 'assistant', 'answer'),
        prompt('u2', 'user', 'second prompt'),
        prompt('a2', 'assistant', 'answer'),
      ]);
    });

    it('asks to go back to the latest prompt without typing the whole name', () => {
      type('/rev');
      expect(press('Enter').defaultPrevented).toBe(true);
      expect(reverted.map((message) => message.id)).toEqual(['u2']);
      expect(editor().textContent).toBe('');
      expect(send).not.toHaveBeenCalled();
    });

    it('runs for a line that starts with the command, whatever follows it', () => {
      type('/revert that last change');
      press('Enter');
      expect(reverted.map((message) => message.id)).toEqual(['u2']);
      expect(send).not.toHaveBeenCalled();
    });

    it('stays in the chat box while the agent is running', () => {
      streaming.set(true);
      type('/revert ');
      press('Enter');
      expect(reverted).toEqual([]);
      expect(send).not.toHaveBeenCalled();
      expect(editor().textContent).toBe('/revert');
    });

    it('stays in the chat box when the session has no prompt yet', () => {
      messages.set([]);
      type('/revert');
      press('Enter');
      expect(reverted).toEqual([]);
      expect(send).not.toHaveBeenCalled();
      expect(editor().textContent).toBe('/revert');
    });
  });

  const CODE = 'def f():\n    if x:\n        return 1';
  const APP: Mention = { kind: 'file', value: 'src/my app/app.ts', label: 'app.ts' };

  function internals(): ComposerInternals {
    return fixture.componentInstance as unknown as ComposerInternals;
  }

  function caretAt(node: Node, offset: number): void {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** Types with the caret behind the text, where the mention picker looks for its query. */
  function typeAtCaret(text: string): void {
    editor().textContent = text;
    caretAt(editor().firstChild!, text.length);
    editor().dispatchEvent(new Event('input'));
  }

  /** Picks a mention from the picker: a pill at the end of the editor. */
  function addPill(mention: Mention = APP): void {
    caretAt(editor(), editor().childNodes.length);
    internals().selectMention({ ...mention, sublabel: null });
  }

  /** Puts another session on screen. */
  function show(sessionId: string): void {
    activeAgent.set({ id: sessionId, model: 'model-x' });
    fixture.detectChanges();
  }

  function file(name: string): File {
    return new File(['some text'], name, { type: 'text/plain' });
  }

  function names(list: MessageAttachment[] = []): string[] {
    return list.map((attachment) => attachment.name).sort();
  }

  /** Lets what was started settle, timers of the file reader included. */
  function settled(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve));
  }

  describe('Tab in the slash menu', () => {
    it('writes out a prompt command whose whole name is typed instead of sending it', () => {
      type('/code-review');
      expect(press('Tab').defaultPrevented).toBe(true);
      expect(editor().textContent).toBe('/code-review ');
      expect(send).not.toHaveBeenCalled();

      // Running it is left to Enter.
      press('Enter');
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ content: '/code-review', promptId: 'code-review' }),
      );
    });

    it('writes out /revert without going back to a prompt', () => {
      const reverted: Message[] = [];
      fixture.componentInstance.revertRequested.subscribe((message) => reverted.push(message));
      messages.set([prompt('u1', 'user', 'first prompt'), prompt('a1', 'assistant', 'answer')]);
      type('/revert');
      press('Tab');
      expect(reverted).toEqual([]);
      expect(editor().textContent).toBe('/revert ');
    });

    it('still picks the highlighted choice of a picker', () => {
      models.set([model('model-x', 'Model X')]);
      type('/effort hi');
      press('Tab');
      expect(updateSession).toHaveBeenCalledWith({
        sessionId: 'session-1',
        reasoningEffort: 'high',
      });
    });
  });

  describe('what a message holds', () => {
    it('is the code as it was typed or pasted, indentation included', () => {
      type(`fix this:\n${CODE}`);
      press('Enter');
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ content: `fix this:\n${CODE}` }));
    });

    it('loses a typed mention and one of the spaces beside it, nothing else', () => {
      type('compare @file:src/a.ts with\n    x  =  1\n@file:src/b.ts\n    y = 2');
      press('Enter');
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'compare with\n    x  =  1\n\n    y = 2',
          mentions: [
            { kind: 'file', value: 'src/a.ts', label: 'src/a.ts' },
            { kind: 'file', value: 'src/b.ts', label: 'src/b.ts' },
          ],
        }),
      );
    });

    it('keeps its indentation as a side question and in the queue', () => {
      type(`/btw what does this do?\n${CODE}`);
      press('Enter');
      expect(ask).toHaveBeenCalledWith('session-1', `what does this do?\n${CODE}`, 'model-x');

      streaming.set(true);
      type(`then fix:\n${CODE}`);
      press('Enter');
      const queued = TestBed.inject(MessageQueueService).forSession('session-1');
      expect(queued.map((item) => item.content)).toEqual([`then fix:\n${CODE}`]);
    });
  });

  describe('the draft of a session', () => {
    const INSERT: ComposerInsert = { mention: APP, text: '@@ -1 +1 @@\n-old\n+new' };

    it('keeps a mention pill while another session is on screen', () => {
      type('explain ');
      addPill();
      show('session-2');
      expect(editor().textContent).toBe('');

      show('session-1');
      expect(editor().querySelectorAll('[data-mention]')).toHaveLength(1);
      press('Enter');
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1', content: 'explain', mentions: [APP] }),
      );
    });

    it('is loaded as it is when it was stored as plain text', () => {
      drafts['session-2'] = 'see @file:src/a.ts\n    and more';
      show('session-2');
      expect(editor().textContent).toBe('see @file:src/a.ts\n    and more');
      expect(editor().children).toHaveLength(0);
    });

    it('is left alone when a handover opens a new session with its summary', () => {
      type('work in progress');
      // The new session and the summary for its chat box arrive together.
      activeAgent.set({ id: 'session-2', model: 'model-x' });
      pendingDraft.set('Summary of the work so far');
      fixture.detectChanges();

      expect(editor().textContent).toBe('Summary of the work so far');
      expect(drafts).toEqual({
        'session-1': 'work in progress',
        'session-2': 'Summary of the work so far',
      });

      show('session-1');
      expect(editor().textContent).toBe('work in progress');
    });

    it('is followed by what the Git view asks about in a chat box that just opened', () => {
      fixture.destroy();
      drafts['session-1'] = 'look at this';
      pendingInsert.set(INSERT);
      fixture = TestBed.createComponent(Composer);
      fixture.detectChanges();

      expect(editor().querySelectorAll('[data-mention]')).toHaveLength(1);
      expect(editor().querySelectorAll('[data-text-block]')).toHaveLength(1);
      press('Enter');
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ content: `look at this ${INSERT.text}`, mentions: [APP] }),
      );
    });

    it('does not take in what the Git view asks about in a session that opens with it', () => {
      type('old draft');
      activeAgent.set({ id: 'session-2', model: 'model-x' });
      pendingInsert.set(INSERT);
      fixture.detectChanges();

      expect(drafts['session-1']).toBe('old draft');
      expect(editor().textContent).not.toContain('old draft');
      expect(editor().querySelectorAll('[data-mention], [data-text-block]')).toHaveLength(2);
      expect(drafts['session-2']).toContain(APP.value);
      expect(drafts['session-2']).not.toContain('old draft');
    });
  });

  describe('a prompt the backend does not take', () => {
    /** A send that the test settles: `true` once the backend has the prompt. */
    function sending(): (taken: boolean) => void {
      let settle!: (taken: boolean) => void;
      send.mockReturnValue(new Promise<boolean>((resolve) => (settle = resolve)));
      return settle;
    }

    it('comes back into the chat box with its mention and its attachment', async () => {
      send.mockResolvedValue(false);
      await internals().addFiles([file('notes.txt')]);
      type('explain ');
      addPill();
      press('Enter');
      expect(editor().textContent).toBe('');

      await vi.waitFor(() => expect(editor().querySelectorAll('[data-mention]')).toHaveLength(1));
      expect(editor().firstChild?.textContent).toBe('explain ');
      expect(names(internals().attachments())).toEqual(['notes.txt']);
      expect(names(kept['session-1'])).toEqual(['notes.txt']);

      // Sent again, it is the prompt it was.
      send.mockResolvedValue(true);
      press('Enter');
      expect(send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          content: 'explain',
          mentions: [APP],
          attachments: [expect.objectContaining({ name: 'notes.txt' })],
        }),
      );
    });

    it('goes in front of what was typed since', async () => {
      const settle = sending();
      type('first prompt');
      press('Enter');
      type('typed since');
      settle(false);
      await vi.waitFor(() => expect(editor().textContent).toBe('first prompt\n\ntyped since'));
    });

    it('waits in the draft of its session while another one is on screen', async () => {
      const settle = sending();
      await internals().addFiles([file('notes.txt')]);
      type('first prompt');
      press('Enter');
      show('session-2');
      type('typed in the other session');
      settle(false);

      await vi.waitFor(() => expect(drafts['session-1']).toBe('first prompt'));
      expect(names(kept['session-1'])).toEqual(['notes.txt']);
      expect(editor().textContent).toBe('typed in the other session');
      expect(internals().attachments()).toEqual([]);
    });

    it('stays out of the chat box once the backend has it', async () => {
      const settle = sending();
      type('first prompt');
      press('Enter');
      // Whatever happens to the turn after that, the prompt is in the chat.
      settle(true);
      await settled();
      expect(editor().textContent).toBe('');
      expect(drafts).toEqual({});
    });
  });

  describe('the files @file suggests', () => {
    const entry = (path: string): WorkspaceEntry => ({ path, kind: 'file' });

    beforeEach(() => activeProject.set({ id: 'p1' }));
    afterEach(() => vi.restoreAllMocks());

    function suggested(): string[] {
      return internals()
        .mentionItems()
        .map((item) => item.value);
    }

    it('are read again each time the picker opens, with the ones from before shown meanwhile', async () => {
      const read = vi.spyOn(api, 'listWorkspaceEntries').mockResolvedValue([entry('src/a.ts')]);
      typeAtCaret('@file:');
      await vi.waitFor(() => expect(suggested()).toEqual(['src/a.ts']));
      typeAtCaret('@file:a');
      expect(read).toHaveBeenCalledTimes(1);

      // The agent writes a file while the picker is closed.
      typeAtCaret('see ');
      let answer!: (entries: WorkspaceEntry[]) => void;
      read.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      typeAtCaret('see @file:');
      expect(read).toHaveBeenCalledTimes(2);
      expect(suggested()).toEqual(['src/a.ts']);
      answer([entry('src/a.ts'), entry('src/b.ts')]);
      await vi.waitFor(() => expect(suggested()).toEqual(['src/a.ts', 'src/b.ts']));
    });

    it('are read on the next keystroke after a read that failed', async () => {
      const read = vi
        .spyOn(api, 'listWorkspaceEntries')
        .mockRejectedValueOnce(new Error('busy'))
        .mockResolvedValue([entry('src/a.ts')]);
      typeAtCaret('@file:');
      await settled();
      expect(suggested()).toEqual([]);

      typeAtCaret('@file:a');
      await vi.waitFor(() => expect(suggested()).toEqual(['src/a.ts']));
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('are not replaced by a slow answer for the project that was on screen before', async () => {
      let answerFirst!: (entries: WorkspaceEntry[]) => void;
      vi.spyOn(api, 'listWorkspaceEntries').mockImplementation((projectId) =>
        projectId === 'p1'
          ? new Promise((resolve) => (answerFirst = resolve))
          : Promise.resolve([entry('other/b.ts')]),
      );
      typeAtCaret('@file:');
      activeProject.set({ id: 'p2' });
      typeAtCaret('@file:b');
      await vi.waitFor(() => expect(suggested()).toEqual(['other/b.ts']));

      answerFirst([entry('src/a.ts'), entry('src/b.ts')]);
      await settled();
      expect(suggested()).toEqual(['other/b.ts']);
    });
  });

  describe('files added to the chat box', () => {
    it('are all kept when two pastes overlap', async () => {
      await Promise.all([
        internals().addFiles([file('a.txt')]),
        internals().addFiles([file('b.txt')]),
      ]);
      expect(names(internals().attachments())).toEqual(['a.txt', 'b.txt']);
      expect(names(kept['session-1'])).toEqual(['a.txt', 'b.txt']);
    });

    it('do not bring back one that was removed while they were read', async () => {
      await internals().addFiles([file('a.txt')]);
      const reading = internals().addFiles([file('b.txt')]);
      internals().removeAttachment(internals().attachments()[0].id);
      await reading;
      expect(names(internals().attachments())).toEqual(['b.txt']);
    });

    it('stay with their session when another one comes on screen while they are read', async () => {
      const reading = internals().addFiles([file('a.txt')]);
      show('session-2');
      await reading;
      expect(internals().attachments()).toEqual([]);
      expect(kept).toEqual({ 'session-1': [expect.objectContaining({ name: 'a.txt' })] });

      show('session-1');
      expect(names(internals().attachments())).toEqual(['a.txt']);
    });
  });
});
