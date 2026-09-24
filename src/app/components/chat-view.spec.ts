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
