import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';
import { CUSTOM_THEME_ID, CustomTheme, DEFAULT_THEME_ID, THEME_PRESETS, findTheme } from './themes';

const root = document.documentElement;

describe('themes', () => {
  it('has unique preset ids and a translation key per preset', () => {
    const ids = THEME_PRESETS.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(CUSTOM_THEME_ID);
    for (const theme of THEME_PRESETS) {
      expect(theme.labelKey).toBe(
        `settings.themes.${theme.id.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}`,
      );
      for (const color of [theme.ink, theme.navy, theme.accent, theme.mist, theme.white]) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('falls back to the default preset for unknown ids', () => {
    expect(findTheme('nope').id).toBe(DEFAULT_THEME_ID);
    expect(findTheme(null).id).toBe(DEFAULT_THEME_ID);
    expect(findTheme('nord').id).toBe('nord');
  });
});

describe('ThemeService', () => {
  let service: ThemeService;

  beforeEach(() => {
    localStorage.clear();
    service = TestBed.inject(ThemeService);
  });

  afterEach(() => {
    localStorage.clear();
    root.removeAttribute('style');
    for (const key of ['theme', 'scheme', 'contrast', 'platform']) {
      delete root.dataset[key];
    }
  });

  it('applies a preset to the document and remembers it', () => {
    service.apply('daylight');

    expect(service.current().id).toBe('daylight');
    expect(root.dataset['theme']).toBe('daylight');
    expect(root.dataset['scheme']).toBe('light');
    expect(root.style.colorScheme).toBe('light');
    expect(root.style.getPropertyValue('--color-accent')).toBe(findTheme('daylight').accent);
    expect(localStorage.getItem('pumr.theme')).toBe('daylight');
  });

  it('normalises unknown ids to the default preset', () => {
    service.apply('removed-theme');
    expect(root.dataset['theme']).toBe(DEFAULT_THEME_ID);
    expect(localStorage.getItem('pumr.theme')).toBe(DEFAULT_THEME_ID);
  });

  it('re-applies the custom palette when it changes while active', () => {
    const custom: CustomTheme = {
      scheme: 'dark',
      ink: '#010101',
      navy: '#020202',
      accent: '#ff00ff',
      mist: '#030303',
      white: '#fefefe',
    };
    service.apply(CUSTOM_THEME_ID);
    service.setCustom(custom);

    expect(service.current()).toMatchObject({ id: CUSTOM_THEME_ID, accent: '#ff00ff' });
    expect(root.dataset['scheme']).toBe('dark');
    expect(root.style.getPropertyValue('--color-accent')).toBe('#ff00ff');
    expect(JSON.parse(localStorage.getItem('pumr.customTheme') ?? '{}')).toEqual(custom);
  });

  it('stores a custom palette without applying it while a preset is active', () => {
    service.apply('nord');
    service.setCustom({ ...service.customColors(), accent: '#123456' });
    expect(root.dataset['theme']).toBe('nord');
    expect(root.style.getPropertyValue('--color-accent')).toBe(findTheme('nord').accent);
  });

  it('toggles high contrast', () => {
    service.applyContrast(true);
    expect(service.highContrast()).toBe(true);
    expect(root.dataset['contrast']).toBe('high');
    expect(localStorage.getItem('pumr.highContrast')).toBe('true');

    service.applyContrast(false);
    expect(root.dataset['contrast']).toBe('normal');
  });

  it('clamps the glass opacity and ignores non-finite values', () => {
    service.applyGlassOpacity(0.3);
    expect(root.style.getPropertyValue('--glass-alpha')).toBe('0.3');
    service.applyGlassOpacity(4);
    expect(root.style.getPropertyValue('--glass-alpha')).toBe('1');
    service.applyGlassOpacity(-1);
    expect(root.style.getPropertyValue('--glass-alpha')).toBe('0');
    service.applyGlassOpacity(Number.NaN);
    expect(root.style.getPropertyValue('--glass-alpha')).toBe('1');
  });

  it('marks the platform on init so styles can scope macOS tweaks', () => {
    service.init();
    expect(['mac', 'other']).toContain(root.dataset['platform']);
  });
});

describe('ThemeService cached state', () => {
  afterEach(() => localStorage.clear());

  it('restores the last theme, contrast and custom palette from storage', () => {
    localStorage.setItem('pumr.theme', 'gruvbox');
    localStorage.setItem('pumr.highContrast', 'true');
    localStorage.setItem('pumr.customTheme', JSON.stringify({ accent: '#abcdef' }));

    const service = TestBed.inject(ThemeService);

    expect(service.current().id).toBe('gruvbox');
    expect(service.highContrast()).toBe(true);
    // Partial stored palettes are completed from the defaults.
    expect(service.customColors().accent).toBe('#abcdef');
    expect(service.customColors().scheme).toBeDefined();
  });

  it('ignores a corrupt stored palette', () => {
    localStorage.setItem('pumr.customTheme', '{not json');
    const service = TestBed.inject(ThemeService);
    expect(service.customColors().accent).toMatch(/^#/);
  });
});
