import { Component, Pipe, PipeTransform, input, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { PermissionRequestEvent, Settings } from '../core/models';
import { FALLBACK_SETTINGS, SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { CopyButton } from './copy-button';
import { PermissionOverlay } from './permission-overlay';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

@Component({ selector: 'app-copy-button', standalone: true, template: '' })
class StubCopyButton {
  readonly text = input<string>('');
  readonly buttonClass = input<string>('');
}

function request(patch: Partial<PermissionRequestEvent> = {}): PermissionRequestEvent {
  return {
    kind: 'permissionRequest',
    requestId: 'req-1',
    promptKind: 'command',
    title: 'Title',
    detail: 'Detail',
    command: 'ls',
    path: null,
    folder: null,
    url: null,
    suggestedRule: 'ls',
    segments: [],
    risk: null,
    scopeOptions: [],
    folders: [],
    ...patch,
  };
}

describe('PermissionOverlay', () => {
  let fixture: ComponentFixture<PermissionOverlay>;
  let resolvePermission: ReturnType<typeof vi.fn>;
  let settingsValue: ReturnType<typeof signal<Settings>>;

  function create(req: PermissionRequestEvent, patch: Partial<Settings> = {}): void {
    resolvePermission = vi.fn().mockResolvedValue(undefined);
    settingsValue = signal<Settings>({ ...FALLBACK_SETTINGS, ...patch });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: WorkspaceService,
          useValue: { resolvePermission, debugOpen: signal(false) },
        },
        {
          provide: SettingsService,
          useValue: { settings: settingsValue.asReadonly(), dialogOpen: signal(false) },
        },
      ],
    });
    TestBed.overrideComponent(PermissionOverlay, {
      remove: { imports: [TranslocoPipe, CopyButton] },
      add: { imports: [StubTranslocoPipe, StubCopyButton] },
    });
    fixture = TestBed.createComponent(PermissionOverlay);
    fixture.componentRef.setInput('request', req);
    fixture.detectChanges();
  }

  function buttons(): HTMLButtonElement[] {
    return [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
  }

  it('focuses the chat-scoped allow button by default', async () => {
    create(request());
    await fixture.whenStable();
    fixture.detectChanges();
    const allow = buttons().find((b) => b.textContent?.includes('permission.allowChat'));
    expect(allow).toBeTruthy();
    expect(document.activeElement).toBe(allow);
  });

  it('focuses allow-once when the command default is once', async () => {
    create(request(), {
      permissionDefaults: { website: 'once', command: 'once', folder: 'once' },
    });
    await fixture.whenStable();
    fixture.detectChanges();
    const allow = buttons().find((b) => b.textContent?.includes('permission.allowOnce'));
    expect(allow).toBeTruthy();
    expect(document.activeElement).toBe(allow);
  });

  it('moves the active button with arrow keys', async () => {
    create(request());
    await fixture.whenStable();
    fixture.detectChanges();
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true });
    document.activeElement?.dispatchEvent(event);
    fixture.detectChanges();
    expect(document.activeElement?.textContent).toContain('permission.allowAlways');
  });

  it('resolves allow_session on Enter by default', async () => {
    create(request());
    await fixture.whenStable();
    fixture.detectChanges();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    fixture.detectChanges();
    expect(resolvePermission).toHaveBeenCalledWith('allow_session', [], []);
  });

  it('resolves allow_once on Enter when the command default is once', async () => {
    create(request(), {
      permissionDefaults: { website: 'once', command: 'once', folder: 'once' },
    });
    await fixture.whenStable();
    fixture.detectChanges();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    fixture.detectChanges();
    expect(resolvePermission).toHaveBeenCalledWith('allow_once');
  });

  it('offers once, session and permanent grants for folder prompts', () => {
    create(
      request({
        promptKind: 'folder',
        command: null,
        folder: '/outside/project',
        suggestedRule: null,
      }),
    );
    const labels = buttons().map((button) => button.textContent ?? '');
    expect(labels.some((text) => text.includes('permission.deny'))).toBe(true);
    expect(labels.some((text) => text.includes('permission.allowOnce'))).toBe(true);
    expect(labels.some((text) => text.includes('permission.allowSession'))).toBe(true);
    expect(labels.some((text) => text.includes('permission.addFolder'))).toBe(true);
  });

  it('resolves a folder session grant with the backend-owned folder', async () => {
    create(
      request({
        promptKind: 'folder',
        command: null,
        folder: '/outside/project',
        suggestedRule: null,
      }),
    );
    buttons()
      .find((button) => button.textContent?.includes('permission.allowSession'))!
      .click();
    expect(resolvePermission).toHaveBeenCalledWith('allow_session');
  });

  it('offers once, session and always for website prompts', () => {
    create(
      request({
        promptKind: 'web',
        command: null,
        url: 'https://example.com/page',
        suggestedRule: 'example.com',
      }),
    );
    const labels = buttons().map((button) => button.textContent ?? '');
    expect(labels.some((text) => text.includes('permission.deny'))).toBe(true);
    expect(labels.some((text) => text.includes('permission.denyAlways'))).toBe(true);
    expect(labels.some((text) => text.includes('permission.allowOnce'))).toBe(true);
    expect(labels.some((text) => text.includes('permission.allowSession'))).toBe(true);
    expect(labels.some((text) => text.includes('permission.allowAlways'))).toBe(true);
  });

  it('resolves a website session grant', async () => {
    create(
      request({
        promptKind: 'web',
        command: null,
        url: 'https://example.com/page',
        suggestedRule: 'example.com',
      }),
    );
    buttons()
      .find((button) => button.textContent?.includes('permission.allowSession'))!
      .click();
    expect(resolvePermission).toHaveBeenCalledWith('allow_session');
  });

  it('marks auto-allowed and pending segments for a compound command', () => {
    create(
      request({
        command: 'echo "hello pipe" | tr \'a-z\' \'A-Z\' && echo "and-this-ran"',
        segments: [
          { text: 'echo "hello pipe" ', allowed: true },
          { text: " tr 'a-z' 'A-Z' ", allowed: false },
          { text: ' echo "and-this-ran"', allowed: true },
        ],
      }),
    );
    const pre = fixture.nativeElement.querySelector('pre') as HTMLElement;
    const spans = [...pre.querySelectorAll('span')] as HTMLElement[];
    const pending = spans.filter((span) => span.className.includes('text-accent'));
    expect(pending.map((span) => span.textContent)).toEqual([" tr 'a-z' 'A-Z' "]);
    expect(fixture.nativeElement.textContent).toContain('permission.segment.allowed');
    expect(fixture.nativeElement.textContent).toContain('permission.segment.needsApproval');
  });

  it('renders the plain command block without a legend when segments are absent', () => {
    create(request({ command: 'pnpm build', segments: [] }));
    const spans = fixture.nativeElement.querySelectorAll('pre span');
    expect(spans.length).toBe(0);
    expect(fixture.nativeElement.textContent).not.toContain('permission.segment.allowed');
  });

  it('passes the selected scope to allow-always', async () => {
    create(
      request({
        command: 'ls -la /test',
        scopeOptions: [
          { kind: 'program', rule: { kind: 'glob', value: 'ls *' } },
          { kind: 'programFlags', rule: { kind: 'glob', value: 'ls -la *' } },
          { kind: 'exact', rule: { kind: 'exact', value: 'ls -la /test' } },
        ],
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    buttons.find((button) => button.textContent?.includes('ls -la /test'))?.click();
    fixture.detectChanges();
    buttons.find((button) => button.textContent?.includes('permission.allowAlways'))?.click();
    expect(resolvePermission).toHaveBeenCalledWith(
      'allow_always',
      [{ kind: 'exact', value: 'ls -la /test' }],
      [],
    );
  });

  it('offers one scope picker per asking segment and grants them separately', async () => {
    create(
      request({
        command: "pnpm --version | tr -d '\\n'",
        segments: [
          {
            text: 'pnpm --version ',
            allowed: false,
            suggestedRule: 'pnpm --version',
            scopeOptions: [
              { kind: 'program', rule: { kind: 'glob', value: 'pnpm *' } },
              { kind: 'exact', rule: { kind: 'exact', value: 'pnpm --version' } },
            ],
          },
          {
            text: " tr -d '\\n'",
            allowed: false,
            suggestedRule: "tr -d '\\n'",
            scopeOptions: [
              { kind: 'program', rule: { kind: 'glob', value: 'tr *' } },
              { kind: 'exact', rule: { kind: 'exact', value: "tr -d '\\n'" } },
            ],
          },
        ],
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    buttons.find((button) => button.textContent?.includes('pnpm *'))?.click();
    buttons.find((button) => button.textContent?.includes('tr *'))?.click();
    fixture.detectChanges();
    buttons.find((button) => button.textContent?.includes('permission.allowAlways'))?.click();
    expect(resolvePermission).toHaveBeenCalledWith(
      'allow_always',
      [
        { kind: 'glob', value: 'pnpm *' },
        { kind: 'glob', value: 'tr *' },
      ],
      [],
    );
  });

  it('offers allow-in-this-chat for command prompts', () => {
    create(
      request({
        command: 'tr a b',
        scopeOptions: [{ kind: 'program', rule: { kind: 'glob', value: 'tr *' } }],
      }),
    );
    const labels = [...fixture.nativeElement.querySelectorAll('button')].map(
      (button) => (button as HTMLButtonElement).textContent,
    );
    expect(labels.some((text) => text?.includes('permission.allowChat'))).toBe(true);
  });

  it.each([
    ['permission.allowAlways', 'allow_always'],
    ['permission.allowChat', 'allow_session'],
    ['permission.denyAlways', 'deny_always'],
  ])('preserves matching kind for identical scope values via %s', (label, decision) => {
    create(
      request({
        command: 'tool *',
        scopeOptions: [
          { kind: 'program', rule: { kind: 'glob', value: 'tool *' } },
          { kind: 'exact', rule: { kind: 'exact', value: 'tool *' } },
        ],
      }),
    );
    const scopes = buttons().filter((button) => button.querySelector('code'));
    expect(scopes).toHaveLength(2);
    expect(scopes.map((button) => button.querySelector('code')?.textContent?.trim())).toEqual([
      'tool *',
      'tool *',
    ]);
    expect(scopes[0].className).toContain('border-accent/60');
    expect(scopes[1].className).not.toContain('border-accent/60');

    const action = buttons().find((button) => button.textContent?.includes(label))!;
    action.click();
    expect(resolvePermission).toHaveBeenLastCalledWith(
      decision,
      [{ kind: 'glob', value: 'tool *' }],
      [],
    );

    scopes[1].click();
    fixture.detectChanges();
    expect(scopes[0].className).not.toContain('border-accent/60');
    expect(scopes[1].className).toContain('border-accent/60');

    action.click();
    expect(resolvePermission).toHaveBeenLastCalledWith(
      decision,
      [{ kind: 'exact', value: 'tool *' }],
      [],
    );
  });
  it('compares selected rules structurally rather than by object identity', () => {
    create(
      request({
        scopeOptions: [{ kind: 'exact', rule: { kind: 'exact', value: 'tool *' } }],
      }),
    );
    fixture.componentInstance['selectedScopeRule'].set({ value: 'tool *', kind: 'exact' });
    fixture.detectChanges();
    expect(buttons().find((button) => button.querySelector('code'))?.className).toContain(
      'border-accent/60',
    );
  });

  it('keeps exact and glob rules with identical values distinct across compound segments', () => {
    create(
      request({
        command: 'tool * && tool *',
        segments: ['tool * ', ' tool *'].map((text) => ({
          text,
          allowed: false,
          scopeOptions: [
            { kind: 'program', rule: { kind: 'glob', value: 'tool *' } },
            { kind: 'exact', rule: { kind: 'exact', value: 'tool *' } },
          ],
        })),
      }),
    );
    const scopes = buttons().filter((button) => button.querySelector('code'));
    expect(scopes).toHaveLength(4);
    expect(scopes.map((button) => button.className.includes('border-accent/60'))).toEqual([
      true,
      false,
      true,
      false,
    ]);
    scopes[1].click();
    fixture.detectChanges();
    expect(scopes.map((button) => button.className.includes('border-accent/60'))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    buttons()
      .find((button) => button.textContent?.includes('permission.allowAlways'))!
      .click();
    expect(resolvePermission).toHaveBeenCalledWith(
      'allow_always',
      [
        { kind: 'exact', value: 'tool *' },
        { kind: 'glob', value: 'tool *' },
      ],
      [],
    );
  });

  it('does not use a suggested command string when typed scopes are absent', () => {
    create(request({ suggestedRule: 'tool *' }));
    buttons()
      .find((button) => button.textContent?.includes('permission.allowAlways'))!
      .click();
    expect(resolvePermission).toHaveBeenCalledWith('allow_always', [], []);
  });

  it('shows a risk chip with the impact detail on hover', () => {
    create(
      request({
        command: 'cat .env',
        risk: { level: 'danger', detail: 'It touches sensitive files.' },
      }),
    );
    const chip = fixture.nativeElement.querySelector('[tabindex="0"]') as HTMLElement | null;
    expect(chip?.textContent).toContain('permission.risk.danger');
    expect(fixture.nativeElement.textContent).toContain('It touches sensitive files.');
  });

  it('omits the risk chip for prompts without risk', () => {
    create(request({ command: 'ls', risk: null }));
    expect(fixture.nativeElement.querySelector('[tabindex="0"]')).toBeNull();
  });

  it('offers outside folders for permanent whitelisting', async () => {
    create(
      request({
        command: 'cat /etc/hosts',
        folders: ['/etc'],
        scopeOptions: [{ kind: 'exact', rule: { kind: 'exact', value: 'cat /etc/hosts' } }],
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const folderButton = buttons().find((button) =>
      button.textContent?.includes('permission.folderScope.option'),
    )!;
    expect(folderButton).toBeTruthy();
    expect(folderButton.textContent).toContain('/etc');
    folderButton.click();
    fixture.detectChanges();
    expect(folderButton.className).toContain('border-accent/60');
    buttons()
      .find((button) => button.textContent?.includes('permission.allowAlways'))!
      .click();
    expect(resolvePermission).toHaveBeenCalledWith(
      'allow_always',
      [{ kind: 'exact', value: 'cat /etc/hosts' }],
      ['/etc'],
    );
  });

  it('shows per-part reasons and no rule scope for parts only a folder can allow', async () => {
    create(
      request({
        command: 'cd /other/repo; pwd; git log 2>/tmp/x',
        detail: 'Combined backend reason',
        folders: ['/other/repo', '/other'],
        segments: [
          {
            text: 'cd /other/repo',
            allowed: false,
            reason: 'Command touches paths outside the project: /other/repo',
            scopeOptions: [],
            folders: ['/other/repo', '/other'],
          },
          { text: ' pwd', allowed: true },
          {
            text: ' git log 2>/tmp/x',
            allowed: false,
            reason: "Command 'git' requires approval",
            scopeOptions: [{ kind: 'program', rule: { kind: 'glob', value: 'git *' } }],
          },
        ],
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('permission.segment.summary');
    expect(text).not.toContain('Combined backend reason');
    expect(text).toContain('Command touches paths outside the project: /other/repo');
    expect(text).toContain("Command 'git' requires approval");
    expect(text).toContain('permission.segment.folderOnly');
    const parts = fixture.nativeElement.querySelectorAll('[data-testid="asking-segment"]');
    expect(parts.length).toBe(2);
    // Only the git part offers a rule scope; the cd part offers none.
    expect(parts[0].querySelectorAll('button').length).toBe(0);
    expect(parts[1].querySelectorAll('button').length).toBe(1);

    // The most specific folder is preselected, the broader parent is not.
    buttons()
      .find((button) => button.textContent?.includes('permission.allowAlways'))!
      .click();
    expect(resolvePermission).toHaveBeenCalledWith(
      'allow_always',
      [{ kind: 'glob', value: 'git *' }],
      ['/other/repo'],
    );
  });

  it('preselects the folder for a single outside command without rule scopes', async () => {
    create(request({ command: 'cat /etc/hosts', folders: ['/etc'], scopeOptions: [] }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('permission.segment.folderOnly');
    buttons()
      .find((button) => button.textContent?.includes('permission.allowChat'))!
      .click();
    expect(resolvePermission).toHaveBeenCalledWith('allow_session', [], ['/etc']);
  });

  it('shortens folders below the home directory for display only', () => {
    create(request({ command: 'ls /Users/me/repo', folders: ['/Users/me/repo'] }));
    fixture.componentInstance['home'].set('/Users/me');
    fixture.detectChanges();
    const folderButton = buttons().find((button) =>
      button.textContent?.includes('permission.folderScope.option'),
    )!;
    expect(folderButton.querySelector('code')?.textContent?.trim()).toBe('~/repo');
    expect(folderButton.getAttribute('title')).toBe('/Users/me/repo');
  });
});
