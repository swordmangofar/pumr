import { Pipe, PipeTransform, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { PermissionRequestEvent, Settings } from '../core/models';
import { FALLBACK_SETTINGS, SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { PermissionOverlay } from './permission-overlay';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
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
      remove: { imports: [TranslocoPipe] },
      add: { imports: [StubTranslocoPipe] },
    });
    fixture = TestBed.createComponent(PermissionOverlay);
    fixture.componentRef.setInput('request', req);
    fixture.detectChanges();
  }

  function buttons(): HTMLButtonElement[] {
    return [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
  }

  it('focuses the allow button by default', async () => {
    create(request());
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
    document.activeElement?.dispatchEvent(event);
    fixture.detectChanges();
    expect(document.activeElement?.textContent).toContain('permission.allowAlways');
  });

  it('resolves allow_once on Enter', async () => {
    create(request());
    await fixture.whenStable();
    fixture.detectChanges();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    fixture.detectChanges();
    expect(resolvePermission).toHaveBeenCalledWith('allow_once');
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
          { kind: 'program', rule: 'ls *' },
          { kind: 'programFlags', rule: 'ls -la *' },
          { kind: 'exact', rule: 'ls -la /test' },
        ],
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const buttons = [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    buttons.find((button) => button.textContent?.includes('ls -la /test'))?.click();
    fixture.detectChanges();
    buttons.find((button) => button.textContent?.includes('permission.allowAlways'))?.click();
    expect(resolvePermission).toHaveBeenCalledWith('allow_always', ['ls -la /test']);
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
              { kind: 'program', rule: 'pnpm *' },
              { kind: 'exact', rule: 'pnpm --version' },
            ],
          },
          {
            text: " tr -d '\\n'",
            allowed: false,
            suggestedRule: "tr -d '\\n'",
            scopeOptions: [
              { kind: 'program', rule: 'tr *' },
              { kind: 'exact', rule: "tr -d '\\n'" },
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
    expect(resolvePermission).toHaveBeenCalledWith('allow_always', ['pnpm *', 'tr *']);
  });

  it('offers allow-in-this-chat for command prompts', () => {
    create(request({ command: 'tr a b', scopeOptions: [{ kind: 'program', rule: 'tr *' }] }));
    const labels = [...fixture.nativeElement.querySelectorAll('button')].map(
      (button) => (button as HTMLButtonElement).textContent,
    );
    expect(labels.some((text) => text?.includes('permission.allowChat'))).toBe(true);
  });

  it('shows a risk chip with the impact detail on hover', () => {
    create(
      request({
        command: 'cat .env',
        risk: { level: 'danger', detail: 'It touches sensitive files.' },
      }),
    );
    const chip = fixture.nativeElement.querySelector(
      '[tabindex="0"]',
    ) as HTMLElement | null;
    expect(chip?.textContent).toContain('permission.risk.danger');
    expect(fixture.nativeElement.textContent).toContain('It touches sensitive files.');
  });

  it('omits the risk chip for prompts without risk', () => {
    create(request({ command: 'ls', risk: null }));
    expect(fixture.nativeElement.querySelector('[tabindex="0"]')).toBeNull();
  });
});
