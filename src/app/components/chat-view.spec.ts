import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Message } from '../core/models';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { ChatView } from './chat-view';

describe('ChatView scrolling', () => {
  let fixture: ComponentFixture<ChatView>;
  let scroll: HTMLDivElement;
  let messages: ReturnType<typeof signal<Message[]>>;

  beforeEach(async () => {
    messages = signal<Message[]>([]);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WorkspaceService,
          useValue: {
            activeAgent: signal({ id: 'session-1' }),
            activeSessionId: signal('session-1'),
            scrollTarget: signal(null),
            messagesFor: () => messages(),
            liveToolsFor: () => [],
            isStreaming: () => false,
          },
        },
        { provide: SettingsService, useValue: {} },
      ],
    });
    TestBed.overrideComponent(ChatView, {
      set: {
        imports: [],
        template: `
          <div #scroll (scroll)="onScroll()"></div>
          <button (click)="scrollToBottom(true)"></button>
        `,
      },
    });
    fixture = TestBed.createComponent(ChatView);
    fixture.detectChanges();
    scroll = fixture.nativeElement.querySelector('div');
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { value: 500 },
    });
    await fixture.whenStable();
  });

  function scrollTo(top: number): void {
    scroll.scrollTop = top;
    scroll.dispatchEvent(new Event('scroll'));
  }

  it('does not snap to the bottom when scrolling across the follow threshold', async () => {
    scrollTo(1400);
    fixture.detectChanges();
    await fixture.whenStable();
    scrollTo(1470);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(1470);
  });

  it('follows new content while pinned to the bottom', async () => {
    scrollTo(1500);
    Object.defineProperty(scroll, 'scrollHeight', { value: 2200 });
    messages.set([]);
    fixture.detectChanges();
    await fixture.whenStable();
    // jsdom does not clamp scrollTop to the scrollable range.
    expect(scroll.scrollTop).toBe(2200);
  });

  it('leaves the reading position alone when new content arrives', async () => {
    scrollTo(1000);
    messages.set([]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(1000);
  });

  it('cancels a queued follow if the user scrolls away', async () => {
    messages.set([]);
    fixture.detectChanges();
    scrollTo(1000);
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(1000);
  });

  it('does not override explicit smooth scrolling with an immediate bottom snap', async () => {
    scrollTo(1000);
    fixture.detectChanges();
    await fixture.whenStable();
    scroll.scrollTo = vi.fn();
    fixture.nativeElement.querySelector('button').click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(scroll.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' });
    expect(scroll.scrollTop).toBe(1000);
  });
});

function message(patch: Partial<Message>): Message {
  return {
    id: 'm',
    sessionId: 'session-1',
    seq: 0,
    role: 'assistant',
    content: '',
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
    ...patch,
  };
}

/** One agent step: an assistant message calling `read` and the tool result. */
function readStep(index: number, content = ''): Message[] {
  const callId = `call-${index}`;
  return [
    message({
      id: `a-${index}`,
      content,
      cost: 0.01,
      toolCalls: [{ id: callId, name: 'read', arguments: `{"path":"/p/f${index}.ts"}` }],
    }),
    message({
      id: `t-${index}`,
      role: 'tool',
      content: 'file text',
      toolCallId: callId,
      toolName: 'read',
      status: 'ok',
    }),
  ];
}

describe('ChatView timeline', () => {
  let fixture: ComponentFixture<ChatView>;
  let messages: ReturnType<typeof signal<Message[]>>;
  let continueSession: ReturnType<typeof vi.fn>;
  let error: ReturnType<typeof signal<string | null>>;

  beforeEach(() => {
    messages = signal<Message[]>([]);
    error = signal<string | null>(null);
    continueSession = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WorkspaceService,
          useValue: {
            activeAgent: signal({ id: 'session-1' }),
            activeSessionId: signal('session-1'),
            activeProject: signal({ path: '/p' }),
            scrollTarget: signal(null),
            messagesFor: () => messages(),
            liveToolsFor: () => [],
            isStreaming: () => false,
            errorFor: () => error(),
            continueSession,
          },
        },
        { provide: SettingsService, useValue: {} },
      ],
    });
    TestBed.overrideComponent(ChatView, {
      set: {
        imports: [],
        template: `
          @if (error(); as err) {
            <button class="retry" (click)="continueGeneration()">{{ err }}</button>
          }
        `,
      },
    });
    fixture = TestBed.createComponent(ChatView);
  });

  function kinds(): string[] {
    const timeline = (
      fixture.componentInstance as unknown as { timeline: () => { kind: string; name?: string }[] }
    ).timeline();
    return timeline.map((entry) =>
      entry.kind === 'message' ? 'message' : `${entry.kind}:${entry.name}`,
    );
  }

  it('groups tool calls of one kind across agent steps', () => {
    messages.set([
      message({ id: 'u', role: 'user', content: 'read both' }),
      ...readStep(1),
      ...readStep(2),
      message({ id: 'final', content: 'Done.' }),
    ]);
    expect(kinds()).toEqual(['message', 'toolGroup:read', 'message']);
  });

  it('keeps assistant steps that say something before calling a tool', () => {
    messages.set([
      message({ id: 'u', role: 'user', content: 'read' }),
      ...readStep(1),
      ...readStep(2, 'Now the second file.'),
    ]);
    expect(kinds()).toEqual(['message', 'tool:read', 'message', 'tool:read']);
  });

  it('retries a failed turn from the error banner', () => {
    error.set('rate limited');
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.retry')!.click();
    expect(continueSession).toHaveBeenCalledWith('session-1');
  });
});
