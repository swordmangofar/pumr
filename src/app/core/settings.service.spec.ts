import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { api } from './api';
import { BackgroundService } from './background.service';
import { DefaultSystemPrompts, Mode, Settings } from './models';
import { ProvidersService } from './providers.service';
import { FALLBACK_SETTINGS } from './settings-defaults';
import { SettingsService } from './settings.service';
import { ThemeService } from './theme.service';
import { ZoomService } from './zoom.service';

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...FALLBACK_SETTINGS, ...patch };
}

describe('SettingsService', () => {
  let service: SettingsService;
  let setActiveLang: ReturnType<typeof vi.fn>;
  let theme: {
    init: ReturnType<typeof vi.fn>;
    apply: ReturnType<typeof vi.fn>;
    setCustom: ReturnType<typeof vi.fn>;
    applyContrast: ReturnType<typeof vi.fn>;
    applyGlassOpacity: ReturnType<typeof vi.fn>;
  };
  let background: { apply: ReturnType<typeof vi.fn> };
  let zoom: { apply: ReturnType<typeof vi.fn> };
  let providers: { load: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    setActiveLang = vi.fn();
    theme = {
      init: vi.fn(),
      apply: vi.fn(),
      setCustom: vi.fn(),
      applyContrast: vi.fn(),
      applyGlassOpacity: vi.fn(),
    };
    background = { apply: vi.fn() };
    zoom = { apply: vi.fn() };
    providers = { load: vi.fn().mockResolvedValue(undefined) };
    TestBed.configureTestingModule({
      providers: [
        { provide: TranslocoService, useValue: { setActiveLang } },
        { provide: ThemeService, useValue: theme },
        { provide: BackgroundService, useValue: background },
        { provide: ZoomService, useValue: zoom },
        { provide: ProvidersService, useValue: providers },
      ],
    });
    service = TestBed.inject(SettingsService);
  });

  afterEach(() => vi.restoreAllMocks());

  it('initialises the theme as soon as it is created', () => {
    expect(theme.init).toHaveBeenCalledTimes(1);
  });

  describe('init', () => {
    const defaults: DefaultSystemPrompts = {
      defaultSystemPrompt: 'default',
      securitySystemPrompt: 'security',
      testingSystemPrompt: 'testing',
      architectureSystemPrompt: 'architecture',
      userSystemPrompts: [{ id: 'u', name: 'User', prompt: 'p', enabled: true }],
    };
    const modes = [{ id: 'coding' }] as Mode[];

    it('loads settings, applies the look and switches the language', async () => {
      const loaded = settings({
        theme: 'nord',
        language: 'de',
        highContrast: true,
        glassOpacity: 0.4,
        zoom: 1.25,
      });
      vi.spyOn(api, 'getSettings').mockResolvedValue(loaded);
      vi.spyOn(api, 'getDefaultSystemPrompts').mockResolvedValue(defaults);
      vi.spyOn(api, 'getDefaultModes').mockResolvedValue(modes);

      await service.init();

      expect(service.settings()).toBe(loaded);
      expect(service.loaded()).toBe(true);
      expect(service.error()).toBeNull();
      expect(theme.setCustom).toHaveBeenCalledWith(loaded.customTheme);
      expect(theme.apply).toHaveBeenCalledWith('nord');
      expect(theme.applyContrast).toHaveBeenCalledWith(true);
      expect(theme.applyGlassOpacity).toHaveBeenCalledWith(0.4);
      expect(background.apply).toHaveBeenCalledWith(loaded);
      expect(zoom.apply).toHaveBeenCalledWith(1.25);
      expect(setActiveLang).toHaveBeenCalledWith('de');
      expect(service.originalSystemPrompts()).toEqual(defaults);
      expect(service.originalUserSystemPrompts()).toEqual(defaults.userSystemPrompts);
      expect(service.originalModes()).toEqual(modes);
      expect(providers.load).toHaveBeenCalledTimes(1);
    });

    it('falls back to the current prompts when the defaults cannot be loaded', async () => {
      const loaded = settings({
        defaultSystemPrompt: 'mine',
        securitySystemPrompt: 'sec',
        language: '',
      });
      vi.spyOn(api, 'getSettings').mockResolvedValue(loaded);
      vi.spyOn(api, 'getDefaultSystemPrompts').mockRejectedValue('unavailable');

      await service.init();

      expect(service.originalSystemPrompts().defaultSystemPrompt).toBe('mine');
      expect(service.originalSystemPrompts().securitySystemPrompt).toBe('sec');
      // An empty language falls back to English.
      expect(setActiveLang).toHaveBeenCalledWith('en');
    });

    it('records the error and still finishes loading when settings fail', async () => {
      vi.spyOn(api, 'getSettings').mockRejectedValue('no backend');

      await service.init();

      expect(service.settings()).toBeNull();
      expect(service.error()).toBe('no backend');
      expect(service.loaded()).toBe(true);
    });
  });

  describe('save and patch', () => {
    it('stores what the backend returns, not what was sent', async () => {
      const normalised = settings({ zoom: 2, language: 'fr', theme: 'dracula' });
      const saveSettings = vi.spyOn(api, 'saveSettings').mockResolvedValue(normalised);

      const result = await service.save(settings({ zoom: 9 }));

      expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ zoom: 9 }));
      expect(result).toBe(normalised);
      expect(service.settings()).toBe(normalised);
      expect(zoom.apply).toHaveBeenLastCalledWith(2);
      expect(theme.apply).toHaveBeenLastCalledWith('dracula');
      expect(setActiveLang).toHaveBeenLastCalledWith('fr');
    });

    it('refuses to patch before settings are loaded', async () => {
      await expect(service.patch({ zoom: 1.1 })).rejects.toThrow('Settings not loaded');
    });

    it('merges a patch into the current settings', async () => {
      vi.spyOn(api, 'getSettings').mockResolvedValue(settings({ autoCompactThreshold: 50 }));
      vi.spyOn(api, 'getDefaultSystemPrompts').mockRejectedValue('skip');
      await service.init();
      const saveSettings = vi.spyOn(api, 'saveSettings').mockImplementation(async (value) => value);

      await service.patch({ soundsEnabled: false });

      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ autoCompactThreshold: 50, soundsEnabled: false }),
      );
    });
  });

  it('keeps the last known settings when a reload fails', async () => {
    const first = settings({ theme: 'nord' });
    vi.spyOn(api, 'getSettings').mockResolvedValueOnce(first).mockRejectedValueOnce('gone');

    await service.reload();
    await service.reload();

    expect(service.settings()).toBe(first);
  });

  it('adopts settings the backend already saved', () => {
    const saved = settings({ providers: { ollama: { baseUrl: '', enabled: true } } });
    service.adopt(saved);
    expect(service.settings()).toBe(saved);
  });

  it('replaces the settings with the result of rule changes', async () => {
    const withRule = settings({ allowedWebsites: ['docs.rs'] });
    const withoutRule = settings({ allowedWebsites: [] });
    vi.spyOn(api, 'addWebsiteRule').mockResolvedValue(withRule);
    vi.spyOn(api, 'deleteWebsiteRule').mockResolvedValue(withoutRule);
    const rule = { kind: 'glob', value: 'npm test*' } as const;
    const withCommand = settings({ commandRules: [rule] });
    const addCommandRule = vi.spyOn(api, 'addCommandRule').mockResolvedValue(withCommand);
    vi.spyOn(api, 'deleteCommandRule').mockResolvedValue(withoutRule);

    await service.addWebsiteRule('docs.rs', true);
    expect(service.settings()).toBe(withRule);
    await service.deleteWebsiteRule('docs.rs', true);
    expect(service.settings()).toBe(withoutRule);
    await service.addCommandRule(rule, false);
    expect(addCommandRule).toHaveBeenCalledWith(rule, false);
    expect(service.settings()).toBe(withCommand);
    await service.deleteCommandRule(rule, false);
    expect(service.settings()).toBe(withoutRule);
  });

  it('tracks which section the settings dialog should focus', () => {
    service.open('providers', 'api-key');
    expect(service.dialogOpen()).toBe(true);
    expect(service.focusSection()).toBe('providers');
    expect(service.focusAnchor()).toBe('api-key');

    service.close();
    expect(service.dialogOpen()).toBe(false);
    expect(service.focusSection()).toBeNull();
    expect(service.focusAnchor()).toBeNull();
    // Closing without saved settings resets any previewed look to defaults.
    expect(theme.apply).toHaveBeenLastCalledWith(undefined);
    expect(zoom.apply).toHaveBeenLastCalledWith(1);
  });
});
