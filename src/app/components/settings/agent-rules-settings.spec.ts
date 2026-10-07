import { Pipe, PipeTransform, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { api } from '../../core/api';
import { CommandRule, McpToolGrant, Settings } from '../../core/models';
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
  let deleteMcpToolGrant: ReturnType<typeof vi.fn>;
  let deleteSecretFolder: ReturnType<typeof vi.fn>;
  let deletePathFolder: ReturnType<typeof vi.fn>;
  let patch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(api, 'getFileIgnoreCatalog').mockResolvedValue([]);
    settings = signal<Settings>({ ...FALLBACK_SETTINGS });
    addCommandRule = vi.fn().mockResolvedValue(undefined);
    deleteCommandRule = vi.fn().mockResolvedValue(undefined);
    deleteMcpToolGrant = vi.fn().mockResolvedValue(undefined);
    deleteSecretFolder = vi.fn().mockResolvedValue(undefined);
    deletePathFolder = vi.fn().mockResolvedValue(undefined);
    patch = vi.fn((key: keyof Settings, value: Settings[keyof Settings]) =>
      settings.update((current) => ({ ...current, [key]: value })),
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SettingsService,
          useValue: {
            settings,
            addCommandRule,
            deleteCommandRule,
            deleteMcpToolGrant,
            deleteSecretFolder,
            deletePathFolder,
          },
        },
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

  it('lists the always-allowed MCP tools and removes the one that was picked', () => {
    const section = fixture.nativeElement.querySelector(
      '[data-testid="mcp-tool-grants"]',
    ) as HTMLElement;
    expect(section.textContent).toContain('settings.noMcpToolGrants');

    // The same tool name on two servers: two entries, told apart by server.
    const grants: McpToolGrant[] = [
      { server: 'codegraph', tool: 'explore', source: '/a/opencode.json', fingerprint: 'aaaa' },
      { server: 'other', tool: 'explore', source: '/b/mcp.json', fingerprint: 'bbbb' },
    ];
    settings.update((current) => ({ ...current, mcpToolGrants: grants }));
    fixture.detectChanges();
    const rows = [...section.querySelectorAll('[data-testid="mcp-tool-grant"]')];
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'explore codegraph /a/opencode.json ✕',
      'explore other /b/mcp.json ✕',
    ]);
    expect(section.textContent).not.toContain('settings.noMcpToolGrants');

    rows[1].querySelector('button')!.click();
    expect(deleteMcpToolGrant).toHaveBeenCalledExactlyOnceWith(grants[1]);
  });

  it('lists the folders with released sensitive files and takes one back', () => {
    const section = fixture.nativeElement.querySelector(
      '[data-testid="secret-folders"]',
    ) as HTMLElement;
    expect(section.textContent).toContain('settings.noSecretFolders');

    const folders = ['/home/me/secrets/credentials', '/home/me/.ssh'];
    settings.update((current) => ({ ...current, secretFolders: folders }));
    fixture.detectChanges();
    const rows = [...section.querySelectorAll('[data-testid="secret-folder"]')];
    expect(rows.map((row) => row.querySelector('code')?.textContent?.trim())).toEqual(folders);
    expect(section.textContent).not.toContain('settings.noSecretFolders');

    rows[1].querySelector('button')!.click();
    expect(deleteSecretFolder).toHaveBeenCalledExactlyOnceWith('/home/me/.ssh');
  });

  it('lists the folders trusted on PATH and stops trusting one', () => {
    const section = fixture.nativeElement.querySelector(
      '[data-testid="path-folders"]',
    ) as HTMLElement;
    expect(section.textContent).toContain('settings.noPathFolders');

    const folders = ['/home/me/.sdkman/candidates/java/11.0.32-amzn/bin', '/opt/node14/bin'];
    settings.update((current) => ({ ...current, pathFolders: folders }));
    fixture.detectChanges();
    const rows = [...section.querySelectorAll('[data-testid="path-folder"]')];
    expect(rows.map((row) => row.querySelector('code')?.textContent?.trim())).toEqual(folders);
    expect(section.textContent).not.toContain('settings.noPathFolders');

    rows[0].querySelector('button')!.click();
    expect(deletePathFolder).toHaveBeenCalledExactlyOnceWith(folders[0]);
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
