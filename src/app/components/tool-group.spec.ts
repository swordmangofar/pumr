import { Component, Pipe, PipeTransform, input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TranslocoPipe } from '@jsverse/transloco';
import { WorkspaceService } from '../core/workspace.service';
import { CopyButton } from './copy-button';
import { ToolGroup, ToolGroupItem } from './tool-group';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string, params?: Record<string, unknown>): string {
    return params ? `${value} ${JSON.stringify(params)}` : value;
  }
}

@Component({ selector: 'app-copy-button', standalone: true, template: '' })
class StubCopyButton {
  readonly text = input<string>('');
  readonly buttonClass = input<string>('');
}

function item(patch: Partial<ToolGroupItem> = {}): ToolGroupItem {
  return {
    key: 'call-1',
    label: 'pnpm test',
    output: '\x1b[32mok\x1b[0m 3 passed',
    live: false,
    status: 'ok',
    additions: 0,
    deletions: 0,
    path: null,
    ...patch,
  };
}

describe('ToolGroup', () => {
  let fixture: ComponentFixture<ToolGroup>;
  let selectChange: ReturnType<typeof vi.fn>;

  function create(name: string, items: ToolGroupItem[]): void {
    selectChange = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [{ provide: WorkspaceService, useValue: { selectChange } }],
    });
    TestBed.overrideComponent(ToolGroup, {
      remove: { imports: [TranslocoPipe, CopyButton] },
      add: { imports: [StubTranslocoPipe, StubCopyButton] },
    });
    fixture = TestBed.createComponent(ToolGroup);
    fixture.componentRef.setInput('name', name);
    fixture.componentRef.setInput('items', items);
    fixture.componentRef.setInput('sessionId', 'session-1');
    fixture.detectChanges();
  }

  function header(): string {
    return (fixture.nativeElement as HTMLElement)
      .querySelector('span.text-sm')!
      .textContent!.trim();
  }

  function labels(): HTMLButtonElement[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
        'button.font-mono',
      ),
    );
  }

  it('counts commands for bash groups', () => {
    create('bash', [item(), item({ key: 'call-2' })]);
    expect(header()).toBe('tools.commandCount {"count":2}');
  });

  it('counts files for file tools', () => {
    create('read', [item({ label: 'a.ts' }), item({ key: 'call-2', label: 'b.ts' })]);
    expect(header()).toBe('tools.fileCount {"count":2}');
  });

  it('expands entries without a diff and renders their ANSI output', () => {
    create('bash', [item(), item({ key: 'call-2' })]);
    labels()[0].click();
    fixture.detectChanges();

    const pre = (fixture.nativeElement as HTMLElement).querySelector('pre')!;
    expect(pre.innerHTML).toContain('color:');
    expect(pre.textContent).toBe('ok 3 passed');
    const copy = fixture.debugElement.query(By.directive(StubCopyButton));
    expect(copy.componentInstance.text()).toBe('ok 3 passed');
    expect(selectChange).not.toHaveBeenCalled();
  });

  it('opens the output of a command that is still printing, until the user closes it', () => {
    const running = item({ status: 'running', live: true, output: 'RUN v3\n' });
    create('bash', [running, item({ key: 'call-2', status: 'running', output: '' })]);
    const pres = (): HTMLPreElement[] =>
      Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('pre'));
    expect(pres().map((pre) => pre.textContent)).toEqual(['RUN v3\n']);

    // It follows what the command prints next.
    fixture.componentRef.setInput('items', [
      { ...running, output: 'RUN v3\n✓ 3 passed\n' },
      item({ key: 'call-2', status: 'running', output: '' }),
    ]);
    fixture.detectChanges();
    expect(pres().map((pre) => pre.textContent)).toEqual(['RUN v3\n✓ 3 passed\n']);

    labels()[0].click();
    fixture.detectChanges();
    expect(pres()).toEqual([]);
  });

  it('closes a command that has ended unless the user opened it', () => {
    const running = item({ status: 'running', live: true, output: 'RUN v3\n' });
    create('bash', [running, item({ key: 'call-2' })]);
    fixture.componentRef.setInput('items', [item(), item({ key: 'call-2' })]);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('pre')).toBeNull();
  });

  it('opens the diff for entries that changed a file', () => {
    create('edit', [item({ path: 'src/a.ts' }), item({ key: 'call-2', path: 'src/b.ts' })]);
    labels()[1].click();
    expect(selectChange).toHaveBeenCalledWith('session-1', 'src/b.ts');
  });
});
