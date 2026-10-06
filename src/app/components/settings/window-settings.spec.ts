import { Component, Pipe, PipeTransform, input, signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { api } from '../../core/api';
import { FALLBACK_SETTINGS } from '../../core/settings.service';
import { Settings, WindowControl, WindowToggleAction } from '../../core/models';
import { CopyButton } from '../copy-button';
import { SettingsDraftService } from './settings-draft.service';
import { WindowSettings } from './window-settings';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

@Component({ selector: 'app-copy-button', standalone: true, template: '' })
class StubCopyButton {
  readonly text = input<string>('');
}

describe('WindowSettings', () => {
  let fixture: ComponentFixture<WindowSettings>;
  let draft: ReturnType<typeof signal<Settings>>;
  let recording: ReturnType<typeof signal<boolean>>;
  let saved: ReturnType<typeof signal<boolean>>;

  afterEach(() => vi.restoreAllMocks());

  /** Creates the component on a desktop that summons the window this way. */
  async function createOn(control: WindowControl, patch: Partial<Settings> = {}): Promise<void> {
    vi.spyOn(api, 'getWindowControl').mockResolvedValue(control);
    create(patch);
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** A desktop where shortcuts work, and what registering this one ran into. */
  function desktop(shortcutError: string | null = null): WindowControl {
    return { toggleCommand: '/usr/bin/pumr --toggle', globalShortcut: true, shortcutError };
  }

  function byTestId(id: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
  }

  function create(patch: Partial<Settings> = {}): void {
    draft = signal<Settings>({ ...FALLBACK_SETTINGS, ...patch });
    recording = signal(false);
    saved = signal(false);
    const stub = {
      draft,
      recording,
      saved,
      patch: (key: keyof Settings, value: Settings[keyof Settings]) => {
        draft.update((current) => ({ ...current, [key]: value }));
      },
    };
    TestBed.configureTestingModule({
      providers: [{ provide: SettingsDraftService, useValue: stub }],
    });
    TestBed.overrideComponent(WindowSettings, {
      remove: { imports: [TranslocoPipe, CopyButton] },
      add: { imports: [StubTranslocoPipe, StubCopyButton] },
    });
    fixture = TestBed.createComponent(WindowSettings);
    fixture.detectChanges();
  }

  function recorderButton(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button.field') as HTMLButtonElement;
  }

  it('enters recording mode when the shortcut button is clicked', () => {
    create({ windowToggleEnabled: true });
    recorderButton().click();
    fixture.detectChanges();
    expect(recording()).toBe(true);
    expect(recorderButton().textContent).toContain('settings.hotkeys.recording');
  });

  it('captures a modifier combination', () => {
    create({ windowToggleEnabled: true });
    recorderButton().click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }));
    fixture.detectChanges();
    expect(draft().windowToggleHotkey).toBe('Ctrl+T');
    expect(recording()).toBe(false);
  });

  it('captures a bare function key', () => {
    create({ windowToggleEnabled: true });
    recorderButton().click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
    fixture.detectChanges();
    expect(draft().windowToggleHotkey).toBe('F2');
  });

  it('lets the action be changed to minimize', () => {
    create({ windowToggleEnabled: true });
    const buttons = fixture.nativeElement.querySelectorAll('button');
    const minimize = [...buttons].find(
      (button: HTMLButtonElement) => button.textContent?.trim() === 'settings.window.actionMinimize',
    ) as HTMLButtonElement;
    minimize.click();
    fixture.detectChanges();
    expect(draft().windowToggleAction).toBe<WindowToggleAction>('minimize');
  });

  it('toggles filling the screen when summoned', () => {
    create({ windowToggleEnabled: true });
    const toggles = [
      ...fixture.nativeElement.querySelectorAll('button.rounded-full'),
    ] as HTMLButtonElement[];
    const fill = toggles.find((button) =>
      button.parentElement?.textContent?.includes('settings.window.fillScreen'),
    ) as HTMLButtonElement;
    fill.click();
    fixture.detectChanges();
    expect(draft().windowToggleMaximize).toBe(true);
  });

  it('keeps the summon options without the shortcut, as the command uses them', () => {
    create();
    expect(recorderButton()).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('settings.window.actionMinimize');
    expect(fixture.nativeElement.textContent).toContain('settings.window.fillScreen');
  });

  it('shows the command that toggles the window', async () => {
    await createOn(desktop());
    expect(byTestId('window-toggle-command')?.textContent).toBe('/usr/bin/pumr --toggle');
    for (const flag of ['--open', '--minimize', '--hide']) {
      expect(fixture.nativeElement.textContent).toContain(flag);
    }
    expect(byTestId('window-shortcut-unavailable')).toBeNull();
  });

  it('says where a system-wide shortcut cannot work', async () => {
    await createOn({ ...desktop(), globalShortcut: false });
    expect(byTestId('window-shortcut-unavailable')?.textContent).toContain(
      'settings.window.waylandHint',
    );
    expect(byTestId('window-toggle-command')).not.toBeNull();
  });

  describe('a shortcut that could not be registered', () => {
    const reason = 'HotKey already registered';

    it('is said so, with the reason', async () => {
      await createOn(desktop(reason), { windowToggleEnabled: true });
      const hint = byTestId('window-shortcut-error');
      expect(hint?.textContent).toContain('settings.window.shortcutError');
      expect(hint?.textContent).toContain(reason);
    });

    it('is not mentioned where registering worked', async () => {
      await createOn(desktop(), { windowToggleEnabled: true });
      expect(byTestId('window-shortcut-error')).toBeNull();
    });

    it('is not mentioned while the shortcut is switched off', async () => {
      await createOn(desktop(reason));
      expect(byTestId('window-shortcut-error')).toBeNull();
    });

    it('shows once the settings that switched it on were saved', async () => {
      await createOn(desktop());
      draft.update((current) => ({ ...current, windowToggleEnabled: true }));
      fixture.detectChanges();
      expect(byTestId('window-shortcut-error')).toBeNull();

      // Saving registers the shortcut, which is when another app's hold on it shows.
      vi.mocked(api.getWindowControl).mockResolvedValue(desktop(reason));
      saved.set(true);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(api.getWindowControl).toHaveBeenCalledTimes(2);
      expect(byTestId('window-shortcut-error')?.textContent).toContain(reason);
    });

    it('is gone once a save registered another combination', async () => {
      await createOn(desktop(reason), { windowToggleEnabled: true });
      expect(byTestId('window-shortcut-error')).not.toBeNull();

      vi.mocked(api.getWindowControl).mockResolvedValue(desktop());
      saved.set(true);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(byTestId('window-shortcut-error')).toBeNull();
    });
  });
});