import { Pipe, PipeTransform, signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { FALLBACK_SETTINGS } from '../../core/settings.service';
import { Settings, WindowToggleAction } from '../../core/models';
import { SettingsDraftService } from './settings-draft.service';
import { WindowSettings } from './window-settings';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

describe('WindowSettings', () => {
  let fixture: ComponentFixture<WindowSettings>;
  let draft: ReturnType<typeof signal<Settings>>;
  let recording: ReturnType<typeof signal<boolean>>;

  function create(patch: Partial<Settings> = {}): void {
    draft = signal<Settings>({ ...FALLBACK_SETTINGS, ...patch });
    recording = signal(false);
    const stub = {
      draft,
      recording,
      patch: (key: keyof Settings, value: Settings[keyof Settings]) => {
        draft.update((current) => ({ ...current, [key]: value }));
      },
    };
    TestBed.configureTestingModule({
      providers: [{ provide: SettingsDraftService, useValue: stub }],
    });
    TestBed.overrideComponent(WindowSettings, {
      remove: { imports: [TranslocoPipe] },
      add: { imports: [StubTranslocoPipe] },
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
});