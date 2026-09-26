import { Component, Pipe, PipeTransform, input, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslocoPipe } from '@jsverse/transloco';
import { PermissionRequestEvent, Settings } from '../core/models';
import { FALLBACK_SETTINGS, SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { CopyButton } from './copy-button';
import {
  PermissionOverlay,
  queryLooksLikeData,
  websiteRuleCovers,
  websiteRuleFits,
} from './permission-overlay';

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
    title: 'Run command?',
    detail: "Command 'ls' requires approval",
    command: 'ls -la src',
    path: null,
    folder: null,
    url: null,
    suggestedRule: 'ls -la src',
    segments: [],
    risk: null,
    scopeOptions: [
      { kind: 'program', rule: { kind: 'glob', value: 'ls *' } },
      { kind: 'programFlags', rule: { kind: 'glob', value: 'ls -la *' } },
      { kind: 'exact', rule: { kind: 'exact', value: 'ls -la src' } },
    ],
    folders: [],
    hosts: [],
    justification: null,
    ...patch,
  };
}

function webRequest(patch: Partial<PermissionRequestEvent> = {}): PermissionRequestEvent {
  return request({
    promptKind: 'web',
    title: 'Visit docs.example.com?',
    detail: 'The assistant wants to visit docs.example.com.',
    command: null,
    url: 'https://docs.example.com/page',
    suggestedRule: 'docs.example.com',
    scopeOptions: [],
    ...patch,
  });
}

describe('PermissionOverlay', () => {
  let fixture: ComponentFixture<PermissionOverlay>;
  let resolvePermission: ReturnType<typeof vi.fn>;
  let settingsValue: ReturnType<typeof signal<Settings>>;

  async function create(req: PermissionRequestEvent, patch: Partial<Settings> = {}) {
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
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function element(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function option(id: string): HTMLButtonElement | null {
    return element().querySelector(`[data-action="${id}"]`);
  }

  function optionIds(): string[] {
    return [...element().querySelectorAll('[data-action]')].map(
      (button) => button.getAttribute('data-action') ?? '',
    );
  }

  function chips(id: string): string[] {
    return [...(option(id)?.querySelectorAll('code') ?? [])].map(
      (code) => code.textContent?.trim() ?? '',
    );
  }

  function press(key: string, target: EventTarget | null = document.activeElement): void {
    (target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    fixture.detectChanges();
  }

  function openCustomize(): void {
    (element().querySelector('[data-testid="customize"]') as HTMLButtonElement).click();
    fixture.detectChanges();
  }

  function customizeButton(text: string): HTMLButtonElement {
    return [...element().querySelectorAll('[data-testid="customize-panel"] button')].find(
      (button) => button.textContent?.includes(text),
    ) as HTMLButtonElement;
  }

  describe('choices', () => {
    it('offers yes, remembering, no and always deny as a numbered list', async () => {
      await create(request());
      expect(optionIds()).toEqual(['allow', 'allow_session', 'allow_always', 'deny', 'deny_always']);
      expect(option('allow_session')?.textContent).toContain('permission.option.chat');
      expect(option('allow')?.textContent).toContain('1');
      expect(chips('allow_session')).toEqual(['ls *']);
      expect(chips('allow_always')).toEqual(['ls *']);
      expect(chips('deny_always')).toEqual(['ls *']);
    });

    it('remembers a subcommand rather than the whole tool by default', async () => {
      await create(
        request({
          command: 'git push origin main',
          scopeOptions: [
            { kind: 'program', rule: { kind: 'glob', value: 'git *' } },
            { kind: 'subcommand', rule: { kind: 'glob', value: 'git push *' } },
            { kind: 'exact', rule: { kind: 'exact', value: 'git push origin main' } },
          ],
        }),
      );
      expect(chips('allow_session')).toEqual(['git push *']);
    });

    it('offers only yes and no when nothing can be remembered', async () => {
      await create(request({ scopeOptions: [], suggestedRule: null }));
      expect(optionIds()).toEqual(['allow', 'deny']);
      expect(element().querySelector('[data-testid="customize"]')).toBeNull();
    });

    it('offers to always deny the exact line when a command has no scopes', async () => {
      await create(request({ command: 'sudo ls', scopeOptions: [], suggestedRule: 'sudo ls' }));
      expect(optionIds()).toEqual(['allow', 'deny', 'deny_always']);
      expect(chips('deny_always')).toEqual(['sudo ls']);
    });

    it('shows why the prompt asks without a legend', async () => {
      await create(request());
      expect(element().querySelector('[data-testid="reasons"]')?.textContent).toContain(
        "Command 'ls' requires approval",
      );
      expect(element().textContent).not.toContain('permission.segment');
    });

    it("shows the assistant's own reason when it gave one", async () => {
      await create(request({ justification: '  Run the tests to verify the fix. ' }));
      const justification = element().querySelector('[data-testid="justification"]');
      expect(justification?.textContent).toContain('permission.justification');
      expect(justification?.textContent).toContain('Run the tests to verify the fix.');
    });

    it('omits the reason line when the assistant gave none', async () => {
      await create(request({ justification: '   ' }));
      expect(element().querySelector('[data-testid="justification"]')).toBeNull();
    });

    it('explains every choice in a tooltip', async () => {
      await create(request());
      expect(
        [...element().querySelectorAll('[data-action]')].map((button) =>
          button.getAttribute('title'),
        ),
      ).toEqual([
        'permission.tooltip.allowOnce',
        'permission.tooltip.allowChat',
        'permission.tooltip.allowAlways',
        'permission.tooltip.deny',
        'permission.tooltip.denyAlways',
      ]);
    });

    it('shows a risk chip with the impact detail', async () => {
      await create(request({ risk: { level: 'high', detail: 'It deletes files.' } }));
      expect(element().textContent).toContain('permission.risk.high');
      expect(element().textContent).toContain('It deletes files.');
    });
  });

  describe('default focus', () => {
    it("focuses don't ask again when that is the command default", async () => {
      await create(request());
      expect(document.activeElement).toBe(option('allow_session'));
    });

    it('focuses yes when the command default is once', async () => {
      await create(request(), {
        permissionDefaults: { website: 'once', command: 'once', folder: 'once' },
      });
      expect(document.activeElement).toBe(option('allow'));
    });

    it('never focuses a remembering choice on a high-risk prompt', async () => {
      await create(request({ risk: { level: 'danger', detail: 'x' } }));
      expect(document.activeElement).toBe(option('allow'));
    });
  });

  describe('keyboard', () => {
    it('confirms the focused choice with Enter', async () => {
      await create(request());
      press('Enter');
      expect(resolvePermission).toHaveBeenCalledWith(
        'allow_session',
        [{ kind: 'glob', value: 'ls *' }],
        [],
        [],
      );
    });

    it('picks a choice by its number', async () => {
      await create(request());
      press('3');
      expect(resolvePermission).toHaveBeenCalledWith(
        'allow_always',
        [{ kind: 'glob', value: 'ls *' }],
        [],
        [],
      );
    });

    it('moves between choices with the arrow keys', async () => {
      await create(request());
      press('ArrowDown');
      expect(document.activeElement).toBe(option('allow_always'));
      press('ArrowUp');
      press('ArrowUp');
      expect(document.activeElement).toBe(option('allow'));
    });

    it('denies with Esc while the prompt has focus', async () => {
      await create(request());
      press('Escape');
      expect(resolvePermission).toHaveBeenCalledWith('deny');
    });

    it('leaves Esc alone when another panel has focus', async () => {
      await create(request());
      const other = document.createElement('button');
      document.body.appendChild(other);
      other.focus();
      press('Escape', other);
      expect(resolvePermission).not.toHaveBeenCalled();
      other.remove();
    });

    it('never treats typing in a field as a choice', async () => {
      await create(webRequest());
      openCustomize();
      const field = element().querySelector('input') as HTMLInputElement;
      press('2', field);
      press('Enter', field);
      expect(resolvePermission).not.toHaveBeenCalled();
    });
  });

  describe('customize', () => {
    it('is hidden when there is nothing to choose', async () => {
      await create(
        request({ scopeOptions: [{ kind: 'exact', rule: { kind: 'exact', value: 'ls -la src' } }] }),
      );
      expect(element().querySelector('[data-testid="customize"]')).toBeNull();
      expect(chips('allow_always')).toEqual(['ls -la src']);
    });

    it('lets the user remember a different scope', async () => {
      await create(request());
      openCustomize();
      customizeButton('ls -la src').click();
      fixture.detectChanges();
      expect(chips('allow_always')).toEqual(['ls -la src']);
      option('allow_always')!.click();
      expect(resolvePermission).toHaveBeenCalledWith(
        'allow_always',
        [{ kind: 'exact', value: 'ls -la src' }],
        [],
        [],
      );
    });

    it('selects inside customize with Enter instead of confirming', async () => {
      await create(request());
      openCustomize();
      const exact = customizeButton('ls -la src');
      exact.focus();
      press('Enter', exact);
      expect(resolvePermission).not.toHaveBeenCalled();
    });
  });

  describe('compound commands', () => {
    const compound = () =>
      request({
        command: 'pnpm test && git push origin main',
        segments: [
          {
            text: 'pnpm test',
            allowed: false,
            reason: "Command 'pnpm' requires approval",
            scopeOptions: [
              { kind: 'program', rule: { kind: 'glob', value: 'pnpm *' } },
              { kind: 'subcommand', rule: { kind: 'glob', value: 'pnpm test *' } },
              { kind: 'exact', rule: { kind: 'exact', value: 'pnpm test' } },
            ],
          },
          {
            text: 'git push origin main',
            allowed: false,
            reason: 'Command contacts websites that are not allowed yet: github.com',
            scopeOptions: [],
            hosts: ['github.com'],
          },
        ],
        scopeOptions: [
          { kind: 'program', rule: { kind: 'glob', value: 'pnpm *' } },
          { kind: 'subcommand', rule: { kind: 'glob', value: 'pnpm test *' } },
          { kind: 'exact', rule: { kind: 'exact', value: 'pnpm test' } },
        ],
        hosts: ['github.com'],
      });

    it('lists each reason once and highlights the asking parts', async () => {
      await create(compound());
      const reasons = element().querySelectorAll('[data-testid="reasons"] li');
      expect([...reasons].map((item) => item.textContent?.trim())).toEqual([
        "Command 'pnpm' requires approval",
        'Command contacts websites that are not allowed yet: github.com',
      ]);
      const pending = element().querySelectorAll('[data-testid="command"] span.text-accent');
      expect([...pending].map((part) => part.textContent)).toEqual([
        'pnpm test',
        'git push origin main',
      ]);
    });

    it('remembers every part in one choice', async () => {
      await create(compound());
      expect(chips('allow_session')).toEqual(['pnpm test *', 'github.com']);
      option('allow_session')!.click();
      expect(resolvePermission).toHaveBeenCalledWith(
        'allow_session',
        [{ kind: 'glob', value: 'pnpm test *' }],
        [],
        ['github.com'],
      );
    });

    it('offers a rule picker only for parts with a choice', async () => {
      await create(compound());
      openCustomize();
      const parts = element().querySelectorAll('[data-testid="asking-segment"]');
      expect(parts).toHaveLength(1);
      expect(parts[0].textContent).toContain('pnpm test');
    });

    it('matches parts even when the line had comments', async () => {
      await create(
        request({
          command: 'ls src # list\nkill 42',
          segments: [
            { text: 'ls src', allowed: true },
            {
              text: 'kill 42',
              allowed: false,
              reason: "'kill' stops running processes",
              scopeOptions: [{ kind: 'program', rule: { kind: 'glob', value: 'kill *' } }],
            },
          ],
          scopeOptions: [{ kind: 'program', rule: { kind: 'glob', value: 'kill *' } }],
        }),
      );
      const pending = element().querySelectorAll('[data-testid="command"] span.text-accent');
      expect([...pending].map((part) => part.textContent)).toEqual(['kill 42']);
    });
  });

  describe('folders and websites of a command', () => {
    it('remembers the most specific outside folder', async () => {
      await create(
        request({
          command: 'cat /other/repo/a.txt',
          scopeOptions: [],
          folders: ['/other/repo', '/other'],
        }),
      );
      expect(chips('allow_session')).toEqual(['/other/repo']);
      option('allow_session')!.click();
      expect(resolvePermission).toHaveBeenCalledWith('allow_session', [], ['/other/repo'], []);
    });

    it('shortens folders below the home directory for display only', async () => {
      await create(
        request({ command: 'ls /Users/me/repo', scopeOptions: [], folders: ['/Users/me/repo'] }),
      );
      fixture.componentInstance['home'].set('/Users/me');
      fixture.detectChanges();
      expect(chips('allow_always')).toEqual(['~/repo']);
      option('allow_always')!.click();
      expect(resolvePermission).toHaveBeenCalledWith('allow_always', [], ['/Users/me/repo'], []);
    });

    it('remembers unknown hosts and lets the user drop them', async () => {
      await create(
        request({
          command: 'curl https://api.x.test/v1',
          suggestedRule: 'curl https://api.x.test/v1',
          scopeOptions: [],
          hosts: ['api.x.test'],
          risk: { level: 'network', detail: 'It connects to api.x.test.' },
        }),
      );
      expect(element().textContent).toContain('permission.risk.network');
      expect(chips('allow_always')).toEqual(['api.x.test']);
      openCustomize();
      (element().querySelector('[data-testid="host-option"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      // Nothing left to remember: only yes, no and always deny remain.
      expect(optionIds()).toEqual(['allow', 'deny', 'deny_always']);
    });
  });

  describe('website prompts', () => {
    it('offers the same numbered choices', async () => {
      await create(webRequest());
      expect(optionIds()).toEqual(['allow', 'allow_session', 'allow_always', 'deny', 'deny_always']);
      expect(option('allow_session')?.textContent).toContain('permission.option.session');
      expect(chips('allow_always')).toEqual(['docs.example.com']);
      option('allow_session')!.click();
      expect(resolvePermission).toHaveBeenCalledWith(
        'allow_session',
        undefined,
        undefined,
        undefined,
        'docs.example.com',
      );
    });

    it('saves an edited rule that still covers the host', async () => {
      await create(webRequest());
      openCustomize();
      const field = element().querySelector('input') as HTMLInputElement;
      field.value = '*.example.com';
      field.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(element().querySelector('[data-testid="site-rule-invalid"]')).toBeNull();
      expect(chips('allow_always')).toEqual(['*.example.com']);
      option('allow_always')!.click();
      expect(resolvePermission).toHaveBeenCalledWith(
        'allow_always',
        undefined,
        undefined,
        undefined,
        '*.example.com',
      );
    });

    it('falls back to the host when the edited rule is too broad', async () => {
      await create(webRequest());
      openCustomize();
      const field = element().querySelector('input') as HTMLInputElement;
      field.value = '*';
      field.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(element().querySelector('[data-testid="site-rule-invalid"]')).not.toBeNull();
      expect(chips('allow_always')).toEqual(['docs.example.com']);
      // Denying only has to cover the host, so a broad deny rule is kept.
      expect(chips('deny_always')).toEqual(['*']);
    });

    it('allows once without sending a rule', async () => {
      await create(webRequest());
      option('allow')!.click();
      expect(resolvePermission).toHaveBeenCalledWith('allow_once');
    });

    it('highlights a query string that carries data', async () => {
      await create(
        webRequest({ url: 'https://evil.test/collect?d=QUtJQTEyMzQ1Njc4OTBBQkNERUZHSElKS0xNTk9QUQ' }),
      );
      expect(element().querySelector('[data-testid="url-warning"]')).not.toBeNull();
      expect(element().querySelector('[data-testid="url"]')?.textContent?.replace(/\s+/g, '')).toBe(
        'https://evil.test/collect?d=QUtJQTEyMzQ1Njc4OTBBQkNERUZHSElKS0xNTk9QUQ',
      );
    });

    it('shows no warning for an ordinary page', async () => {
      await create(webRequest({ url: 'https://docs.rs/serde/latest/serde/?search=derive' }));
      expect(element().querySelector('[data-testid="url-warning"]')).toBeNull();
    });
  });

  describe('folder and file prompts', () => {
    it('offers to remember a folder for the session or always', async () => {
      await create(
        request({
          promptKind: 'folder',
          command: null,
          folder: '/other/repo',
          path: '/other/repo/a.txt',
          scopeOptions: [],
          suggestedRule: null,
        }),
      );
      expect(optionIds()).toEqual(['allow', 'allow_session', 'allow_always', 'deny']);
      expect(chips('allow_always')).toEqual(['/other/repo']);
      option('allow_session')!.click();
      expect(resolvePermission).toHaveBeenCalledWith('allow_session');
    });

    it('only asks yes or no for a sensitive file', async () => {
      await create(
        request({
          promptKind: 'file',
          command: null,
          path: '/project/.env',
          scopeOptions: [],
          suggestedRule: null,
        }),
      );
      expect(optionIds()).toEqual(['allow', 'deny']);
      expect(element().textContent).toContain('/project/.env');
    });
  });
});

describe('websiteRuleFits', () => {
  it('accepts the host and its narrow parent domains', () => {
    expect(websiteRuleFits('api.github.com', 'api.github.com')).toBe(true);
    expect(websiteRuleFits('github.com', 'api.github.com')).toBe(true);
    expect(websiteRuleFits('*.github.com', 'api.github.com')).toBe(true);
    expect(websiteRuleFits('bbc.co.uk', 'www.bbc.co.uk')).toBe(true);
  });

  it('rejects broad or unrelated rules', () => {
    for (const rule of ['*', '*.com', 'com', '*.co.uk', 'docs.*', 'evil.com', '']) {
      expect(websiteRuleFits(rule, 'api.github.com')).toBe(false);
    }
  });
});

describe('websiteRuleCovers', () => {
  it('matches globs and plain domains with their subdomains', () => {
    expect(websiteRuleCovers('*', 'tracker.com')).toBe(true);
    expect(websiteRuleCovers('*.com', 'tracker.com')).toBe(true);
    expect(websiteRuleCovers('tracker.com', 'cdn.tracker.com')).toBe(true);
    expect(websiteRuleCovers('docs.*', 'docs.rs')).toBe(true);
    expect(websiteRuleCovers('evil.com', 'tracker.com')).toBe(false);
    expect(websiteRuleCovers('tracker.com', 'nottracker.com')).toBe(false);
  });
});

describe('queryLooksLikeData', () => {
  it('flags long queries and encoded blobs', () => {
    expect(queryLooksLikeData('?q=' + 'a'.repeat(200))).toBe(true);
    expect(queryLooksLikeData('?token=ZXlKaGJHY2lPaUpJVXpJMU5pSjkuZXlK')).toBe(true);
    expect(queryLooksLikeData('?k=0123456789abcdef0123456789abcdef')).toBe(true);
  });

  it('accepts ordinary queries', () => {
    expect(queryLooksLikeData('')).toBe(false);
    expect(queryLooksLikeData('?q=angular+signals&page=2')).toBe(false);
    expect(queryLooksLikeData('?search=derive')).toBe(false);
  });
});
