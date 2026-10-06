import { TestBed } from '@angular/core/testing';
import { LogoService } from './logo.service';
import { DEFAULT_LOGO_ID, LOGOS, findLogo } from './logos';

describe('logos', () => {
  it('has unique ids, a translation key and its own file per logo', () => {
    const ids = LOGOS.map((logo) => logo.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_LOGO_ID);
    for (const logo of LOGOS) {
      expect(logo.labelKey).toBe(`settings.logo.${logo.id}`);
      expect(logo.src).toBe(`logo-${logo.id}.svg`);
    }
  });

  it('falls back to the default logo for unknown ids', () => {
    expect(findLogo('nope').id).toBe(DEFAULT_LOGO_ID);
    expect(findLogo(null).id).toBe(DEFAULT_LOGO_ID);
    expect(findLogo('classic').id).toBe('classic');
  });
});

describe('LogoService', () => {
  let icon: HTMLLinkElement;

  beforeEach(() => {
    localStorage.clear();
    icon = document.createElement('link');
    icon.rel = 'icon';
    icon.type = 'image/svg+xml';
    icon.setAttribute('href', 'logo.svg');
    document.head.append(icon);
  });

  afterEach(() => {
    localStorage.clear();
    icon.remove();
  });

  it('starts on the default logo', () => {
    const service = TestBed.inject(LogoService);

    expect(service.current().id).toBe(DEFAULT_LOGO_ID);
    expect(icon.getAttribute('href')).toBe('logo-mascot.svg');
  });

  it('starts on the logo remembered from the last run', () => {
    localStorage.setItem('pumr.logo', 'classic');

    expect(TestBed.inject(LogoService).current().id).toBe('classic');
    expect(icon.getAttribute('href')).toBe('logo-classic.svg');
  });

  it('applies a logo to the header and page icon and remembers it', () => {
    const service = TestBed.inject(LogoService);

    service.apply('classic');

    expect(service.current().src).toBe('logo-classic.svg');
    expect(icon.getAttribute('href')).toBe('logo-classic.svg');
    expect(localStorage.getItem('pumr.logo')).toBe('classic');
  });

  it('normalises unknown ids to the default logo', () => {
    const service = TestBed.inject(LogoService);

    service.apply('removed-logo');

    expect(service.current().id).toBe(DEFAULT_LOGO_ID);
    expect(localStorage.getItem('pumr.logo')).toBe(DEFAULT_LOGO_ID);
  });
});
