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
});
