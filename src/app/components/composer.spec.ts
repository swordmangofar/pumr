import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { Message } from '../core/models';
import { ModelsService } from '../core/models.service';
import { FALLBACK_SETTINGS, SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { Composer } from './composer';

function prompt(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, attachments: [], mentions: [], toolCalls: [] } as unknown as Message;
}

describe('Composer keyboard', () => {
  let fixture: ComponentFixture<Composer>;
  let streaming: ReturnType<typeof signal<boolean>>;
  let messages: ReturnType<typeof signal<Message[]>>;
  let stop: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    streaming = signal(false);
    messages = signal<Message[]>([]);
    stop = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WorkspaceService,
          useValue: {
            activeAgent: signal({ id: 'session-1' }),
            activeSession: signal({ id: 'session-1' }),
            activeProject: signal(null),
            isStreaming: () => streaming(),
            isHandover: () => false,
            messagesFor: () => messages(),
            contextUsage: signal({}),
            pendingDraft: signal(null),
            consumeDraft: vi.fn(),
            pendingComposerInsert: signal(null),
            consumeComposerInsert: vi.fn(),
            composerDraftFor: () => '',
            composerAttachmentsFor: () => [],
            setComposerDraft: vi.fn(),
            setComposerAttachments: vi.fn(),
            composerFocusNonce: signal(0),
            stop,
          },
        },
        {
          provide: SettingsService,
          useValue: {
            settings: signal(FALLBACK_SETTINGS),
            modes: signal([]),
            hasApiKey: signal(true),
          },
        },
        {
          provide: ModelsService,
          useValue: {
            loadProviders: vi.fn().mockResolvedValue(undefined),
            loadEndpoints: vi.fn().mockResolvedValue(undefined),
            byId: () => undefined,
            endpoints: signal({}),
            models: signal([]),
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
});
