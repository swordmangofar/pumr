import { SIT_FRAME_DATA } from './puma-art';

export const BACKGROUND_NONE = 'none';
export const BACKGROUND_CUSTOM = 'custom';

/**
 * A background layer is described declaratively so the same definition can be
 * applied to the live app backdrop and rendered as a small settings preview.
 *
 * `image`/`color` feed the layer's paint, while `mask` clips it to a shape.
 * Mask-based presets therefore inherit the active theme colours: the paint is a
 * theme gradient, the mask is a neutral (white) SVG silhouette.
 */
export interface BackgroundStyle {
  image?: string;
  color?: string;
  size?: string;
  position?: string;
  repeat?: string;
  mask?: string;
  maskSize?: string;
  maskPosition?: string;
  maskRepeat?: string;
  blend?: string;
  opacity?: number;
}

export interface BackgroundPreset {
  id: string;
  labelKey: string;
  scheme: 'dark' | 'light' | 'any';
  style: BackgroundStyle;
  /** Optional overrides so masks stay legible in the small settings preview. */
  preview?: BackgroundStyle;
}

function svgUrl(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Turns `#` pixel art into a crisp SVG silhouette used as a mask. */
function pixelSvg(rows: readonly string[]): string {
  const height = rows.length;
  const width = Math.max(...rows.map((row) => row.length));
  const cells: string[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] === '#') {
        cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
      }
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges"><g fill="#fff">${cells.join('')}</g></svg>`;
}

/**
 * Stroke outlines for the handful of characters used by the ASCII puma. Text
 * is deliberately avoided: fonts are not painted when an SVG is rasterised as
 * a CSS mask, so the glyphs are drawn as plain paths instead.
 */
const ASCII_GLYPHS: Record<string, string> = {
  '/': 'M1 13 L7 1',
  '\\': 'M1 1 L7 13',
  _: 'M0.5 13 L7.5 13',
  '|': 'M4 1 L4 13',
  '^': 'M1 6 L4 1.5 L7 6',
  "'": 'M4.5 1 L3.5 4.5',
  '`': 'M3 1 L5.5 4',
  ',': 'M4.5 11.5 L3 14.5',
};

function asciiSvg(lines: readonly string[], cellW = 8, cellH = 14): string {
  const cols = Math.max(...lines.map((line) => line.length));
  const pad = 12;
  const width = cols * cellW + pad * 2;
  const height = lines.length * cellH + pad * 2;
  const glyphs: string[] = [];
  lines.forEach((line, row) => {
    for (let col = 0; col < line.length; col += 1) {
      const char = line[col];
      if (char === ' ') {
        continue;
      }
      const x = pad + col * cellW;
      const y = pad + row * cellH;
      if (char === 'o') {
        glyphs.push(`<circle cx="${x + 4}" cy="${y + 7}" r="3"/>`);
        continue;
      }
      const path = ASCII_GLYPHS[char];
      if (path) {
        glyphs.push(`<path d="${path}" transform="translate(${x},${y})"/>`);
      }
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${glyphs.join('')}</g></svg>`;
}

function topoSvg(): string {
  const paths: string[] = [];
  for (let i = 0; i < 14; i += 1) {
    const y = 24 + i * 30;
    const d = `M -24 ${y} C 72 ${y - 34}, 156 ${y + 34}, 252 ${y} S 432 ${y - 34}, 504 ${y}`;
    paths.push(`<path d="${d}" fill="none" stroke="#fff" stroke-width="1.4"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="504" height="460" viewBox="0 0 504 460">${paths.join('')}</svg>`;
}

function circuitSvg(): string {
  const traces = [
    'M 0 40 H 120 V 120 H 240',
    'M 0 200 H 60 V 280 H 200',
    'M 360 0 V 90 H 280 V 180',
    'M 360 260 V 360 H 220',
    'M 120 40 V 200',
    'M 240 120 V 240 H 360',
    'M 60 280 V 360',
    'M 280 180 H 400',
  ];
  const nodes = [
    [120, 40],
    [240, 120],
    [60, 280],
    [200, 280],
    [280, 180],
    [220, 360],
    [400, 180],
  ];
  const svgPaths = traces
    .map((d) => `<path d="${d}" fill="none" stroke="#fff" stroke-width="2"/>`)
    .join('');
  const svgNodes = nodes
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="#fff"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360" viewBox="0 0 360 360">${svgPaths}${svgNodes}</svg>`;
}

function hexSvg(): string {
  const path = 'M 36 2 L 66 19 L 66 53 L 36 70 L 6 53 L 6 19 Z';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><path d="${path}" fill="none" stroke="#fff" stroke-width="1.5"/></svg>`;
}

function pawShapes(): string {
  return [
    '<ellipse cx="32" cy="40" rx="16" ry="12"/>',
    '<ellipse cx="15" cy="22" rx="6.5" ry="8.5"/>',
    '<ellipse cx="29" cy="13" rx="6.5" ry="8.5"/>',
    '<ellipse cx="43" cy="15" rx="6.5" ry="8.5"/>',
    '<ellipse cx="54" cy="28" rx="6" ry="8"/>',
  ].join('');
}

function pawTrailSvg(): string {
  const shapes = pawShapes();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260" viewBox="0 0 260 260"><g fill="#fff"><g transform="translate(18,22) rotate(22 32 32)">${shapes}</g><g transform="translate(150,150) rotate(22 32 32)">${shapes}</g></g></svg>`;
}

const ASCII_PUMA: readonly string[] = [
  '      /\\___/\\',
  '     /  o o  \\',
  '    |    ^    |',
  '    |  \\___/  |',
  '     \\       /',
  '      \\_____/',
];

const GRID_LINE = 'color-mix(in oklab, var(--color-accent) 12%, transparent)';
const DIM_ACCENT = (amount: number): string =>
  `color-mix(in oklab, var(--color-accent) ${amount}%, transparent)`;
const DIM_NAVY = (amount: number): string =>
  `color-mix(in oklab, var(--color-navy) ${amount}%, transparent)`;
const DIM_MIST = (amount: number): string =>
  `color-mix(in oklab, var(--color-mist) ${amount}%, transparent)`;

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: 'aurora',
    labelKey: 'settings.background.presets.aurora',
    scheme: 'any',
    style: {
      image: [
        `radial-gradient(60rem 40rem at 12% 8%, ${DIM_ACCENT(26)}, transparent 60%)`,
        `radial-gradient(52rem 38rem at 88% 16%, ${DIM_NAVY(85)}, transparent 62%)`,
        `radial-gradient(70rem 52rem at 50% 112%, ${DIM_ACCENT(18)}, transparent 66%)`,
      ].join(', '),
      size: 'auto',
    },
  },
  {
    id: 'mesh',
    labelKey: 'settings.background.presets.mesh',
    scheme: 'any',
    style: {
      image: [
        `radial-gradient(40rem 32rem at 20% 25%, ${DIM_ACCENT(22)}, transparent 60%)`,
        `radial-gradient(38rem 30rem at 78% 30%, ${DIM_NAVY(90)}, transparent 62%)`,
        `radial-gradient(34rem 28rem at 55% 78%, ${DIM_MIST(14)}, transparent 60%)`,
        `radial-gradient(30rem 24rem at 10% 85%, ${DIM_ACCENT(16)}, transparent 62%)`,
      ].join(', '),
      size: 'auto',
    },
  },
  {
    id: 'grid',
    labelKey: 'settings.background.presets.grid',
    scheme: 'any',
    style: {
      image: [
        `linear-gradient(${GRID_LINE} 1px, transparent 1px)`,
        `linear-gradient(90deg, ${GRID_LINE} 1px, transparent 1px)`,
      ].join(', '),
      size: '44px 44px',
    },
  },
  {
    id: 'dots',
    labelKey: 'settings.background.presets.dots',
    scheme: 'any',
    style: {
      image: `radial-gradient(${DIM_ACCENT(30)} 1.5px, transparent 1.6px)`,
      size: '26px 26px',
    },
  },
  {
    id: 'topo',
    labelKey: 'settings.background.presets.topo',
    scheme: 'any',
    style: {
      image: `linear-gradient(135deg, ${DIM_ACCENT(70)}, ${DIM_NAVY(80)})`,
      mask: svgUrl(topoSvg()),
      maskSize: '520px 480px',
      opacity: 0.35,
    },
    preview: { maskSize: '200px 180px' },
  },
  {
    id: 'circuit',
    labelKey: 'settings.background.presets.circuit',
    scheme: 'any',
    style: {
      image: `linear-gradient(120deg, ${DIM_ACCENT(70)}, ${DIM_MIST(28)})`,
      mask: svgUrl(circuitSvg()),
      maskSize: '360px 360px',
      opacity: 0.3,
    },
    preview: { maskSize: '160px 160px' },
  },
  {
    id: 'hex',
    labelKey: 'settings.background.presets.hex',
    scheme: 'any',
    style: {
      image: `linear-gradient(180deg, ${DIM_NAVY(80)}, ${DIM_ACCENT(45)})`,
      mask: svgUrl(hexSvg()),
      maskSize: '72px 72px',
      opacity: 0.35,
    },
    preview: { maskSize: '36px 36px' },
  },
  {
    id: 'puma',
    labelKey: 'settings.background.presets.puma',
    scheme: 'any',
    style: {
      image: `linear-gradient(140deg, ${DIM_ACCENT(70)}, ${DIM_NAVY(70)})`,
      mask: svgUrl(pixelSvg(SIT_FRAME_DATA)),
      maskSize: 'auto 72%',
      maskPosition: 'right 4% center',
      maskRepeat: 'no-repeat',
      opacity: 0.3,
    },
    preview: { maskSize: 'auto 88%', maskPosition: 'center' },
  },
  {
    id: 'puma-trail',
    labelKey: 'settings.background.presets.pumaTrail',
    scheme: 'any',
    style: {
      image: `linear-gradient(135deg, ${DIM_ACCENT(55)}, transparent 72%)`,
      mask: svgUrl(pawTrailSvg()),
      maskSize: '260px 260px',
      opacity: 0.4,
    },
    preview: { maskSize: '120px 120px' },
  },
  {
    id: 'puma-ascii',
    labelKey: 'settings.background.presets.pumaAscii',
    scheme: 'any',
    style: {
      image: `linear-gradient(120deg, ${DIM_ACCENT(75)}, ${DIM_MIST(25)})`,
      mask: svgUrl(asciiSvg(ASCII_PUMA)),
      maskSize: 'auto 76%',
      maskPosition: 'center',
      maskRepeat: 'no-repeat',
      opacity: 0.32,
    },
    preview: { maskSize: 'auto 90%' },
  },
];

export function findBackground(id: string | null | undefined): BackgroundPreset | null {
  if (!id || id === BACKGROUND_NONE || id === BACKGROUND_CUSTOM) {
    return null;
  }
  return BACKGROUND_PRESETS.find((preset) => preset.id === id) ?? null;
}
