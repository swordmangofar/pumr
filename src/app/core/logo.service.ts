import { Injectable, computed, signal } from '@angular/core';
import { DEFAULT_LOGO_ID, LOGOS, LogoOption, findLogo } from './logos';

const STORAGE_KEY = 'pumr.logo';

/**
 * The logo in the app header and the page icon. The choice is saved with the
 * settings; it is also cached locally so the header starts on the right logo
 * instead of swapping once the settings arrive.
 */
@Injectable({ providedIn: 'root' })
export class LogoService {
  readonly options = LOGOS;
  private readonly activeId = signal<string>(this.readCached());
  readonly current = computed<LogoOption>(() => findLogo(this.activeId()));

  constructor() {
    this.apply(this.activeId());
  }

  apply(id: string | null | undefined): void {
    const logo = findLogo(id);
    this.activeId.set(logo.id);
    this.writeCached(logo.id);
    document
      .querySelector('link[rel="icon"][type="image/svg+xml"]')
      ?.setAttribute('href', logo.src);
  }

  private readCached(): string {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_LOGO_ID;
    } catch {
      return DEFAULT_LOGO_ID;
    }
  }

  private writeCached(value: string): void {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Storage is unavailable; the logo still applies for this session.
    }
  }
}
