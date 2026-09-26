import { Component, input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { api } from '../core/api';
import { MonacoService } from '../core/monaco.service';
import { CopyButton } from './copy-button';
import { MarkdownCode } from './markdown-code';
import { MarkdownView } from './markdown-view';

@Component({ selector: 'app-copy-button', standalone: true, template: '' })
class StubCopyButton {
  readonly text = input<string>('');
  readonly buttonClass = input<string>('');
}

describe('MarkdownView', () => {
  let fixture: ComponentFixture<MarkdownView>;

  function render(content: string, streaming = false): HTMLElement {
    fixture.componentRef.setInput('content', content);
    fixture.componentRef.setInput('streaming', streaming);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function carets(element: HTMLElement): Element[] {
    return [...element.querySelectorAll('.animate-pulse')];
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: MonacoService, useValue: { colorizeFence: () => Promise.resolve(null) } },
      ],
    });
    TestBed.overrideComponent(MarkdownCode, {
      remove: { imports: [CopyButton] },
      add: { imports: [StubCopyButton] },
    });
    fixture = TestBed.createComponent(MarkdownView);
  });

  it('renders tables, bold text, inline code and links', () => {
    const element = render(
      [
        '| Service | URL |',
        '|---|---|',
        '| Frontend | http://localhost:4200 |',
        '',
        '**Open it.** Built `3.66 kB`.',
      ].join('\n'),
    );

    expect([...element.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
      'Service',
      'URL',
    ]);
    expect(element.querySelector('td a')?.textContent).toBe('http://localhost:4200');
    expect(element.querySelector('p strong')?.textContent).toBe('Open it.');
    expect(element.querySelector('p code')?.textContent).toBe('3.66 kB');
    expect(element.querySelector('p')?.textContent).toBe('Open it. Built 3.66 kB.');
  });

  it('opens web links in the system browser without navigating the app', () => {
    const open = vi.spyOn(api, 'openExternalUrl').mockResolvedValue(undefined);
    const link = render('See [the docs](https://example.com/docs).').querySelector('a')!;

    expect(link.hasAttribute('href')).toBe(false);
    expect(link.getAttribute('title')).toBe('https://example.com/docs');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(open).toHaveBeenCalledWith('https://example.com/docs');
    expect(click.defaultPrevented).toBe(true);
    open.mockRestore();
  });

  it('does not make other link targets clickable', () => {
    const element = render('[run](javascript:alert(1)) and [file](src/app.ts)');

    expect(element.querySelector('a')).toBeNull();
    expect(element.textContent).toBe('run and file');
  });

  it('shows raw HTML as text instead of rendering it', () => {
    const element = render('<img src="x" onerror="alert(1)"> <script>alert(1)</script>');

    expect(element.querySelector('img')).toBeNull();
    expect(element.querySelector('script')).toBeNull();
    expect(element.textContent).toContain('<img src="x" onerror="alert(1)">');
  });

  it('renders code blocks with their language and a copy button', () => {
    const element = render('```ts\nconst a = 1;\n```');

    expect(element.querySelector('pre code')?.textContent).toBe('const a = 1;');
    expect(element.textContent).toContain('ts');
    expect(element.querySelector('app-copy-button')).not.toBeNull();
  });

  it('renders task lists as checkboxes', () => {
    const boxes = [
      ...render('- [x] done\n- [ ] open').querySelectorAll<HTMLInputElement>('li input'),
    ];

    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(boxes.every((box) => box.disabled)).toBe(true);
  });

  it('shows the streaming caret at the end of the last block only', () => {
    let element = render('First paragraph.\n\n- one\n- two', true);
    expect(carets(element)).toHaveLength(1);
    expect(carets(element)[0].closest('li')?.textContent).toBe('two');

    element = render('```sh\nnpm run', true);
    expect(carets(element)).toHaveLength(1);
    expect(carets(element)[0].closest('pre')).not.toBeNull();

    element = render('First paragraph.\n\n- one\n- two', false);
    expect(carets(element)).toHaveLength(0);
  });

  it('can stream without the caret', () => {
    fixture.componentRef.setInput('caret', false);
    const element = render('Planning **the** change', true);

    expect(carets(element)).toHaveLength(0);
    expect(element.querySelector('p app-stream-text')?.textContent).toBe('Planning ');
  });

  it('streams new text into the last block', () => {
    let element = render('Hello', true);
    expect(element.querySelector('p app-stream-text')?.textContent).toBe('Hello');

    element = render('Hello world', true);
    const chunks = element.querySelectorAll('p app-stream-text .stream-chunk');
    expect(chunks[chunks.length - 1]?.textContent).toBe(' world');

    element = render('Hello world', false);
    expect(element.querySelector('app-stream-text')).toBeNull();
    expect(element.querySelector('p')?.textContent).toBe('Hello world');
  });
});
