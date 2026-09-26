import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StickToBottom } from './stick-to-bottom';

@Component({
  imports: [StickToBottom],
  template: `<div [appStickToBottom]="text()">{{ text() }}</div>`,
})
class Host {
  readonly text = signal('a');
}

describe('StickToBottom', () => {
  let fixture: ComponentFixture<Host>;
  let panel: HTMLDivElement;

  beforeEach(async () => {
    // Only animation frames are faked; Angular's scheduler still ticks on its timeout.
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    panel = fixture.nativeElement.querySelector('div');
    Object.defineProperties(panel, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { value: 200 },
    });
    await fixture.whenStable();
    vi.advanceTimersToNextFrame();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function scrollTo(top: number): void {
    panel.scrollTop = top;
    panel.dispatchEvent(new Event('scroll'));
  }

  async function grow(text: string, height: number): Promise<void> {
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: height });
    fixture.componentInstance.text.set(text);
    fixture.detectChanges();
    await fixture.whenStable();
    vi.advanceTimersToNextFrame();
  }

  it('follows growing content while at the bottom', async () => {
    scrollTo(790);
    await grow('ab', 1400);
    // jsdom does not clamp scrollTop to the scrollable range.
    expect(panel.scrollTop).toBe(1400);
  });

  it('leaves the reading position alone after scrolling up', async () => {
    scrollTo(300);
    await grow('ab', 1400);
    expect(panel.scrollTop).toBe(300);
  });

  it('follows again once scrolled back to the bottom', async () => {
    scrollTo(300);
    await grow('ab', 1400);
    scrollTo(1200);
    await grow('abc', 1800);
    expect(panel.scrollTop).toBe(1800);
  });
});
