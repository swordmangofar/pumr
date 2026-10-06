/** A logo the user can pick. `src` is a file written by scripts/icon.mjs. */
export interface LogoOption {
  id: string;
  labelKey: string;
  src: string;
}

export const DEFAULT_LOGO_ID = 'mascot';

export const LOGOS: LogoOption[] = [
  { id: 'mascot', labelKey: 'settings.logo.mascot', src: 'logo-mascot.svg' },
  { id: 'classic', labelKey: 'settings.logo.classic', src: 'logo-classic.svg' },
  { id: 'shaded', labelKey: 'settings.logo.shaded', src: 'logo-shaded.svg' },
  { id: 'tailup', labelKey: 'settings.logo.tailup', src: 'logo-tailup.svg' },
];

export function findLogo(id: string | null | undefined): LogoOption {
  return LOGOS.find((logo) => logo.id === id) ?? LOGOS.find((logo) => logo.id === DEFAULT_LOGO_ID)!;
}
