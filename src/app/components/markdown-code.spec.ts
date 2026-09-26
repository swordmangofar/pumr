import { Component, input, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MarkdownLive } from '../core/markdown';
import { MonacoService } from '../core/monaco.service';
import { ThemeService } from '../core/theme.service';
import { CopyButton } from './copy-button';
import { MarkdownCode } from './markdown-code';

@Component({ selector: 'app-copy-button', standalone: true, template: '' })
class StubCopyButton {
  readonly text = input<string>('');
  readonly buttonClass = input<string>('');
}

interface Pending {
  text: string;
  lang: string;
  resolve(html: string | null): void;
}

describe('MarkdownCode', () => {
  let fixture: ComponentFixture<MarkdownCode>;
  let pending: Pending[];
  let theme: ReturnType<typeof signal<{ id: string }>>;

  beforeEach(() => {
    pending = [];
    theme = signal({ id: 'dark' });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MonacoService,
          useValue: {
            colorizeFence: (text: string, lang: string) =>
              new Promise<string | null>((resolve) => pending.push({ text, lang, resolve })),
          },
        },
        { provide: ThemeService, useValue: { current: theme } },
      ],
    });
    TestBed.overrideComponent(MarkdownCode, {
      remove: { imports: [CopyButton] },
      add: { imports: [StubCopyButton] },
    });
    fixture = TestBed.createComponent(MarkdownCode);
  });

  function render(text: string, lang: string, live: MarkdownLive = null): HTMLElement {
    fixture.componentRef.setInput('text', text);
    fixture.componentRef.setInput('lang', lang);
    fixture.componentRef.setInput('live', live);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  async function settle(): Promise<HTMLElement> {
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function code(): HTMLElement {
    return (fixture.nativeElement as HTMLElement).querySelector('pre code')!;
  }

  it('shows the language and colorizes the finished block', async () => {
    const element = render('const a = 1;', 'ts');
    expect(element.textContent).toContain('ts');
    expect(code().textContent).toBe('const a = 1;');
    expect(pending.map(({ text, lang }) => [text, lang])).toEqual([['const a = 1;', 'ts']]);

    pending[0].resolve('<span class="mtk6">const</span><span class="mtk1"> a = 1;</span><br/>');
    await settle();

    expect(code().querySelector('.mtk6')?.textContent).toBe('const');
    expect(code().textContent).toBe('const a = 1;');
  });

  it('keeps streaming blocks plain and colorizes them once complete', async () => {
    render('npm run', 'sh', 'caret');
    expect(pending).toHaveLength(0);
    expect(code().querySelector('app-stream-text')?.textContent).toBe('npm run');
    expect(code().querySelector('.animate-pulse')).not.toBeNull();

    render('npm run build', 'sh', null);
    expect(pending.map(({ text }) => text)).toEqual(['npm run build']);
    pending[0].resolve('<span class="mtk22">npm</span><span class="mtk1"> run build</span>');
    await settle();

    expect(code().querySelector('.mtk22')).not.toBeNull();
    expect(code().querySelector('.animate-pulse')).toBeNull();
  });

  it('leaves blocks without a known language as plain text', async () => {
    render('just text', '');
    expect(pending).toHaveLength(0);

    render('key = "value"', 'toml');
    pending[0].resolve(null);
    await settle();

    expect(code().children).toHaveLength(0);
    expect(code().textContent).toBe('key = "value"');
  });

  it('ignores a result that arrives after the text changed', async () => {
    render('old()', 'ts');
    render('new()', 'ts');
    pending[0].resolve('<span class="mtk1">old()</span>');
    await settle();
    expect(code().textContent).toBe('new()');

    pending[1].resolve('<span class="mtk1">new()</span>');
    await settle();
    expect(code().querySelector('.mtk1')?.textContent).toBe('new()');
  });

  it('colorizes again when the theme changes', async () => {
    render('let x = 1;', 'rust');
    pending[0].resolve('<span class="mtk5">let</span>');
    await settle();

    theme.set({ id: 'light' });
    fixture.detectChanges();
    expect(pending).toHaveLength(2);
    // The previous colors stay until the new ones arrive.
    expect(code().querySelector('.mtk5')).not.toBeNull();
  });

  it('still sanitizes the colorized markup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render('x', 'ts');
    pending[0].resolve('<span class="mtk1">x</span><img src="x" onerror="alert(1)">');
    await settle();

    expect(code().querySelector('[onerror]')).toBeNull();
    warn.mockRestore();
  });
});
