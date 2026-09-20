import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

interface Badge {
  label: string;
  bg: string;
  fg: string;
  size: number;
}

const BADGES: Record<string, Badge> = {
  ts: { label: 'TS', bg: '#3178c6', fg: '#ffffff', size: 9 },
  js: { label: 'JS', bg: '#f7df1e', fg: '#1a1a1a', size: 9 },
  json: { label: '{}', bg: '#cbcb41', fg: '#1a1a1a', size: 10 },
  html: { label: '<>', bg: '#e34c26', fg: '#ffffff', size: 10 },
  css: { label: 'CSS', bg: '#2965f1', fg: '#ffffff', size: 7 },
  scss: { label: 'SC', bg: '#cf649a', fg: '#ffffff', size: 9 },
  less: { label: 'LE', bg: '#2a4d80', fg: '#ffffff', size: 9 },
  vue: { label: 'V', bg: '#41b883', fg: '#ffffff', size: 10 },
  svelte: { label: 'S', bg: '#ff3e00', fg: '#ffffff', size: 10 },
  md: { label: 'MD', bg: '#519aba', fg: '#ffffff', size: 8 },
  rs: { label: 'RS', bg: '#dea584', fg: '#1a1a1a', size: 9 },
  py: { label: 'PY', bg: '#3572a5', fg: '#ffffff', size: 9 },
  rb: { label: 'RB', bg: '#701516', fg: '#ffffff', size: 9 },
  go: { label: 'GO', bg: '#00add8', fg: '#ffffff', size: 8 },
  java: { label: 'JV', bg: '#b07219', fg: '#ffffff', size: 9 },
  kt: { label: 'KT', bg: '#a97bff', fg: '#ffffff', size: 8 },
  swift: { label: 'SW', bg: '#f05138', fg: '#ffffff', size: 8 },
  c: { label: 'C', bg: '#5c6bc0', fg: '#ffffff', size: 10 },
  cpp: { label: 'C+', bg: '#f34b7d', fg: '#ffffff', size: 9 },
  cs: { label: 'C#', bg: '#178600', fg: '#ffffff', size: 8 },
  php: { label: 'PHP', bg: '#4f5d95', fg: '#ffffff', size: 6 },
  sh: { label: '>_', bg: '#89e051', fg: '#1a1a1a', size: 8 },
  yaml: { label: 'Y', bg: '#cb171e', fg: '#ffffff', size: 10 },
  toml: { label: 'T', bg: '#9c4221', fg: '#ffffff', size: 10 },
  sql: { label: 'SQL', bg: '#e38c00', fg: '#ffffff', size: 6 },
  graphql: { label: 'GQ', bg: '#e10098', fg: '#ffffff', size: 8 },
  docker: { label: 'DO', bg: '#2496ed', fg: '#ffffff', size: 8 },
};

const EXTENSIONS: Record<string, string> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  md: 'md',
  markdown: 'md',
  mdx: 'md',
  rs: 'rs',
  py: 'py',
  rb: 'rb',
  go: 'go',
  java: 'java',
  kt: 'kt',
  kts: 'kt',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'cs',
  php: 'php',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  fish: 'sh',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'toml',
  cfg: 'toml',
  conf: 'toml',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  svg: 'svg',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  ico: 'image',
  bmp: 'image',
  lock: 'lock',
  txt: 'text',
  log: 'text',
};

const SPECIAL: Record<string, string> = {
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitkeep': 'git',
  '.editorconfig': 'config',
  '.prettierrc': 'config',
  '.prettierignore': 'config',
  '.eslintrc': 'config',
  '.eslintignore': 'config',
  '.babelrc': 'config',
  '.npmrc': 'config',
  '.nvmrc': 'config',
  '.env': 'config',
  dockerfile: 'docker',
  makefile: 'config',
};

function detect(name: string): string {
  const lower = name.toLowerCase();
  if (lower in SPECIAL) {
    return SPECIAL[lower];
  }
  if (lower.startsWith('.env.')) {
    return 'config';
  }
  if (lower === 'license' || lower.startsWith('license.') || lower === 'licence') {
    return 'text';
  }
  if (lower === 'readme' || lower.startsWith('readme.')) {
    return 'md';
  }
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) {
    return 'file';
  }
  return EXTENSIONS[lower.slice(dot + 1)] ?? 'file';
}

@Component({
  selector: 'app-file-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex h-4 w-4 shrink-0 items-center justify-center' },
  template: `
    @if (badge(); as b) {
      <span
        class="flex h-full w-full items-center justify-center rounded-[3px] font-bold tracking-tight"
        [style.background]="b.bg"
        [style.color]="b.fg"
        [style.font-size.px]="b.size"
        >{{ b.label }}</span
      >
    } @else {
      @switch (type()) {
        @case ('git') {
          <svg
            viewBox="0 0 16 16"
            class="h-4 w-4 text-orange-400/80"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="5" cy="3.5" r="1.75" />
            <circle cx="5" cy="12.5" r="1.75" />
            <circle cx="11" cy="6" r="1.75" />
            <path d="M5 5.25v5.5" />
            <path d="M9.5 7.2a3 3 0 0 1-2.6 3" />
          </svg>
        }
        @case ('config') {
          <svg
            viewBox="0 0 16 16"
            class="h-4 w-4 text-mist/50"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="8" cy="8" r="2" />
            <path
              d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"
            />
          </svg>
        }
        @case ('image') {
          <svg
            viewBox="0 0 16 16"
            class="h-4 w-4 text-mist/50"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          >
            <rect x="2" y="2.75" width="12" height="10.5" rx="1.25" />
            <circle cx="5.5" cy="6" r="1" />
            <path d="M3 11.5l3-3 2.5 2.5L11 8.5l2 2" />
          </svg>
        }
        @case ('svg') {
          <svg
            viewBox="0 0 16 16"
            class="h-4 w-4 text-mist/50"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="2" y="2.75" width="12" height="10.5" rx="1.25" />
            <path d="M5 9.5c1.5 1.2 4.5 1.2 6-1.5" />
          </svg>
        }
        @case ('lock') {
          <svg
            viewBox="0 0 16 16"
            class="h-4 w-4 text-mist/45"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3.5" y="7" width="9" height="6.25" rx="1.25" />
            <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
          </svg>
        }
        @default {
          <svg
            viewBox="0 0 16 16"
            class="h-4 w-4 text-mist/45"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4 1.75h4.5L12 5.25v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1Z" />
            <path d="M8.25 1.75v3.5h3.5" />
          </svg>
        }
      }
    }
  `,
})
export class FileIcon {
  readonly name = input.required<string>();
  protected readonly type = computed(() => detect(this.name()));
  protected readonly badge = computed(() => BADGES[this.type()] ?? null);
}
