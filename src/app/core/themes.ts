export interface ThemePreset {
  id: string;
  labelKey: string;
  scheme: 'dark' | 'light';
  ink: string;
  navy: string;
  accent: string;
  mist: string;
  white: string;
}

export const CUSTOM_THEME_ID = 'custom';

export interface ThemeColors {
  ink: string;
  navy: string;
  accent: string;
  mist: string;
  white: string;
}

export interface CustomTheme extends ThemeColors {
  scheme: 'dark' | 'light';
}

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  scheme: 'light',
  ink: '#fbf1c7',
  navy: '#ebdbb2',
  accent: '#458588',
  mist: '#504945',
  white: '#050505',
};

export function buildCustomPreset(custom: CustomTheme): ThemePreset {
  return {
    id: CUSTOM_THEME_ID,
    labelKey: 'settings.themes.custom',
    scheme: custom.scheme,
    ink: custom.ink,
    navy: custom.navy,
    accent: custom.accent,
    mist: custom.mist,
    white: custom.white,
  };
}

export const DEFAULT_THEME_ID = 'midnight';

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'midnight',
    labelKey: 'settings.themes.midnight',
    scheme: 'dark',
    ink: '#000000',
    navy: '#1e293b',
    accent: '#f59e0b',
    mist: '#e5e5e5',
    white: '#ffffff',
  },
  {
    id: 'oled',
    labelKey: 'settings.themes.oled',
    scheme: 'dark',
    ink: '#000000',
    navy: '#0a0a0a',
    accent: '#22d3ee',
    mist: '#d4d4d8',
    white: '#ffffff',
  },
  {
    id: 'dracula',
    labelKey: 'settings.themes.dracula',
    scheme: 'dark',
    ink: '#282a36',
    navy: '#44475a',
    accent: '#bd93f9',
    mist: '#f8f8f2',
    white: '#f8f8f2',
  },
  {
    id: 'nord',
    labelKey: 'settings.themes.nord',
    scheme: 'dark',
    ink: '#2e3440',
    navy: '#3b4252',
    accent: '#88c0d0',
    mist: '#eceff4',
    white: '#eceff4',
  },
  {
    id: 'rose-pine',
    labelKey: 'settings.themes.rosePine',
    scheme: 'dark',
    ink: '#191724',
    navy: '#26233a',
    accent: '#ebbcba',
    mist: '#e0def4',
    white: '#e0def4',
  },
  {
    id: 'gruvbox',
    labelKey: 'settings.themes.gruvbox',
    scheme: 'dark',
    ink: '#282828',
    navy: '#3c3836',
    accent: '#fabd2f',
    mist: '#ebdbb2',
    white: '#ebdbb2',
  },
  {
    id: 'daylight',
    labelKey: 'settings.themes.daylight',
    scheme: 'light',
    ink: '#f8fafc',
    navy: '#dbe3ef',
    accent: '#b45309',
    mist: '#1e293b',
    white: '#0f172a',
  },
  {
    id: 'solarized-light',
    labelKey: 'settings.themes.solarizedLight',
    scheme: 'light',
    ink: '#fdf6e3',
    navy: '#eee8d5',
    accent: '#268bd2',
    mist: '#073642',
    white: '#002b36',
  },
  {
    id: 'github-light',
    labelKey: 'settings.themes.githubLight',
    scheme: 'light',
    ink: '#ffffff',
    navy: '#eef2f6',
    accent: '#0969da',
    mist: '#1f2328',
    white: '#1f2328',
  },
  {
    id: 'catppuccin-latte',
    labelKey: 'settings.themes.catppuccinLatte',
    scheme: 'light',
    ink: '#eff1f5',
    navy: '#e6e9ef',
    accent: '#1e66f5',
    mist: '#4c4f69',
    white: '#4c4f69',
  },
  {
    id: 'rose-pine-dawn',
    labelKey: 'settings.themes.rosePineDawn',
    scheme: 'light',
    ink: '#faf4ed',
    navy: '#f2e9e1',
    accent: '#b4637a',
    mist: '#575279',
    white: '#575279',
  },
  {
    id: 'nord-light',
    labelKey: 'settings.themes.nordLight',
    scheme: 'light',
    ink: '#eceff4',
    navy: '#e5e9f0',
    accent: '#5e81ac',
    mist: '#2e3440',
    white: '#2e3440',
  },
  {
    id: 'gruvbox-light',
    labelKey: 'settings.themes.gruvboxLight',
    scheme: 'light',
    ink: '#fbf1c7',
    navy: '#ebdbb2',
    accent: '#b57614',
    mist: '#3c3836',
    white: '#3c3836',
  },
  {
    id: 'patricks-retro',
    labelKey: 'settings.themes.patricksRetro',
    scheme: 'light',
    ink: '#fbf1c7',
    navy: '#ebdbb2',
    accent: '#458588',
    mist: '#050505',
    white: '#050505',
  },
];

export function findTheme(id: string | null | undefined): ThemePreset {
  return THEME_PRESETS.find((theme) => theme.id === id) ?? THEME_PRESETS[0];
}
