import { Pipe, PipeTransform, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { api } from '../../core/api';
import { CommandRule, Settings } from '../../core/models';
import { FALLBACK_SETTINGS, SettingsService } from '../../core/settings.service';
import { AgentRulesSettings } from './agent-rules-settings';
import { SettingsDraftService } from './settings-draft.service';

@Pipe({ name: 'transloco', standalone: true })
class StubTranslocoPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

describe('AgentRulesSettings command rules', () => {
  let fixture: ComponentFixture<AgentRulesSettings>;
  let settings: ReturnType<typeof signal<Settings>>;
  let addCommandRule: ReturnType<typeof vi.fn>;
  let deleteCommandRule: ReturnType<typeof vi.fn>;
  let patch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(api, 'getFileIgnoreCatalog').mockResolvedValue([]);
    settings = signal<Settings>({ ...FALLBACK_SETTINGS });
    addCommandRule = vi.fn().mockResolvedValue(undefined);
    deleteCommandRule = vi.fn().mockResolvedValue(undefined);
    patch = vi.fn((key: keyof Settings, value: Settings[keyof Settings]) =>
      settings.update((current) => ({ ...current, [key]: value })),
    );
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsService, useValue: { settings, addCommandRule, deleteCommandRule } },
        { provide: SettingsDraftService, useValue: { draft: settings, patch } },
      ],
    });
    TestBed.overrideComponent(AgentRulesSettings, {
      remove: { imports: [TranslocoPipe] },
      add: { imports: [StubTranslocoPipe] },
    });
    fixture = TestBed.createComponent(AgentRulesSettings);
    fixture.detectChanges();
  });

  afterEach(() => vi.restoreAllMocks());

  function commandSection(): HTMLElement {
    return [...fixture.nativeElement.querySelectorAll('section')].find((section) =>
      (section as HTMLElement).querySelector('h3')?.textContent?.includes('settings.commandRules'),
    ) as HTMLElement;
  }

  it.each([true, false])('adds exact rules by default (allow=%s)', async (allow) => {
    const section = commandSection();
    expect(section.querySelector('select')?.value).toBe('exact');
    const input = section.querySelector('input')!;
    input.value = '  tool *?[x]{y}\\z  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    const label = allow ? 'settings.allowCommand' : 'settings.denyCommand';
    [...section.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(label))!
      .click();
    await fixture.whenStable();
    expect(addCommandRule).toHaveBeenCalledWith(
      { kind: 'exact', value: 'tool *?[x]{y}\\z' },
      allow,
    );
    expect(input.value).toBe('');
  });

  it.each([true, false])(
    'adds glob rules only when explicitly selected (allow=%s)',
    async (allow) => {
      const section = commandSection();
      const select = section.querySelector('select')!;
      select.value = 'glob';
      select.dispatchEvent(new Event('input', { bubbles: true }));
      const input = section.querySelector('input')!;
      input.value = 'tool *';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const label = allow ? 'settings.allowCommand' : 'settings.denyCommand';
      [...section.querySelectorAll('button')]
        .find((button) => button.textContent?.includes(label))!
        .click();
      await fixture.whenStable();
      expect(addCommandRule).toHaveBeenCalledWith({ kind: 'glob', value: 'tool *' }, allow);
    },
  );

  it.each([true, false])(
    'labels and deletes same-text rules by their complete kind and value (allow=%s)',
    (allow) => {
      const rules: CommandRule[] = [
        { kind: 'exact', value: 'tool *' },
        { kind: 'glob', value: 'tool *' },
        { kind: 'glob', value: 'tool ?' },
      ];
      const key = allow ? 'commandRules' : 'deniedCommandRules';
      settings.update((current) => ({ ...current, [key]: rules }));
      fixture.detectChanges();
      const codes = [...commandSection().querySelectorAll('code')];
      expect(codes.map((code) => code.textContent)).toEqual(['tool *', 'tool *', 'tool ?']);
      expect(
        codes.map((code) => code.parentElement?.querySelector('span')?.textContent?.trim()),
      ).toEqual([
        'settings.scope.exact',
        'settings.websiteScope.glob',
        'settings.websiteScope.glob',
      ]);

      settings.update((current) => ({ ...current, [key]: rules.map((rule) => ({ ...rule })) }));
      fixture.detectChanges();
      const refreshed = [...commandSection().querySelectorAll('code')];
      refreshed.forEach((code, index) => {
        expect(code).toBe(codes[index]);
        code.parentElement!.parentElement!.querySelector('button')!.click();
        expect(deleteCommandRule).toHaveBeenNthCalledWith(index + 1, rules[index], allow);
      });
    },
  );

  it('does not add an empty rule', () => {
    const section = commandSection();
    const input = section.querySelector('input')!;
    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...section.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('settings.allowCommand'))!
      .click();
    expect(addCommandRule).not.toHaveBeenCalled();
  });

  it('toggles automatic approval settings', () => {
    const section = [...fixture.nativeElement.querySelectorAll('section')].find((entry) =>
      (entry as HTMLElement).querySelector('h3')?.textContent?.includes('settings.autoApprove'),
    ) as HTMLElement;
    expect(section).toBeTruthy();
    expect(section.querySelectorAll('app-toggle')).toHaveLength(4);

    const instance = fixture.componentInstance as unknown as {
      isAuto: (key: string) => boolean;
      toggleAuto: (key: string) => void;
    };
    expect(instance.isAuto('autoApproveProjectCommands')).toBe(true);
    instance.toggleAuto('autoApproveProjectCommands');
    expect(patch).toHaveBeenCalledWith('autoApproveProjectCommands', false);
    expect(instance.isAuto('autoApproveProjectCommands')).toBe(false);
  });

  function presetButton(preset: string): HTMLButtonElement {
    return fixture.nativeElement.querySelector(`[data-preset="${preset}"]`) as HTMLButtonElement;
  }

  it('applies presets and shows custom mixes', () => {
    expect(presetButton('autonomous').className).toContain('border-accent/60');
    presetButton('strict').click();
    fixture.detectChanges();
    expect(settings().autoApproveReadOnly).toBe(true);
    expect(settings().autoApprovePackageScripts).toBe(false);
    expect(settings().autoApproveProjectExecutables).toBe(false);
    expect(settings().autoApproveProjectCommands).toBe(false);
    expect(presetButton('strict').className).toContain('border-accent/60');

    presetButton('balanced').click();
    fixture.detectChanges();
    expect(settings().autoApprovePackageScripts).toBe(true);
    expect(settings().autoApproveProjectExecutables).toBe(true);
    expect(settings().autoApproveProjectCommands).toBe(false);

    const instance = fixture.componentInstance as unknown as { toggleAuto: (key: string) => void };
    instance.toggleAuto('autoApproveReadOnly');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="custom-preset"]')).not.toBeNull();
  });

  it('asks for confirmation before switching to autonomous', () => {
    presetButton('strict').click();
    fixture.detectChanges();
    presetButton('autonomous').click();
    fixture.detectChanges();
    expect(settings().autoApproveProjectCommands).toBe(false);
    const warning = fixture.nativeElement.querySelector('[data-testid="autonomous-warning"]');
    expect(warning).not.toBeNull();
    (warning.querySelector('[data-testid="confirm-autonomous"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(settings().autoApproveProjectCommands).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="autonomous-warning"]')).toBeNull();
  });
});
