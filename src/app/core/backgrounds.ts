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

/** Smooth closed path through the given points (Catmull-Rom to cubic Bézier). */
function smoothClosedPath(points: readonly (readonly [number, number])[], tension = 6): string {
  const n = points.length;
  let d = `M ${points[0][0]} ${points[0][1]} `;
  for (let i = 0; i < n; i += 1) {
    const [x0, y0] = points[(i - 1 + n) % n];
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    const [x3, y3] = points[(i + 2) % n];
    const c1x = x1 + (x2 - x0) / tension;
    const c1y = y1 + (y2 - y0) / tension;
    const c2x = x2 - (x3 - x1) / tension;
    const c2y = y2 - (y3 - y1) / tension;
    d += `C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${x2} ${y2} `;
  }
  return `${d}Z`;
}

function polygon(points: readonly (readonly [number, number])[]): string {
  return `M ${points.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`;
}

/**
 * Filled night scene used as a mask: jagged mountain ranges, a crescent moon,
 * scattered stars, pine trees and a puma silhouette in the foreground. Every
 * shape is painted white; the theme gradient supplies the colour.
 */
function mountainNightSvg(): string {
  const width = 1000;
  const height = 620;

  const pumaMain: readonly (readonly [number, number])[] = [
    [48, 132],
    [88, 112],
    [138, 80],
    [153, 36],
    [183, 66],
    [211, 34],
    [246, 76],
    [300, 88],
    [360, 74],
    [460, 66],
    [560, 78],
    [592, 100],
    [622, 78],
    [642, 46],
    [652, 14],
    [636, 12],
    [616, 44],
    [600, 90],
    [608, 200],
    [616, 300],
    [600, 330],
    [560, 336],
    [548, 310],
    [548, 210],
    [470, 210],
    [330, 205],
    [322, 210],
    [318, 300],
    [292, 330],
    [260, 324],
    [256, 210],
    [215, 200],
    [190, 175],
    [150, 162],
    [100, 150],
    [56, 140],
  ];
  const leg = (
    back: number,
    front: number,
    top: number,
    bottom: number,
  ): readonly (readonly [number, number])[] => [
    [back, top],
    [front, top],
    [front - 6, bottom - 28],
    [front - 11, bottom],
    [back + 11, bottom],
    [back + 6, bottom - 28],
  ];
  const pumaFarHind = leg(482, 540, 210, 318);
  const pumaFarFront = leg(342, 400, 205, 322);

  const stars: string[] = [];
  for (let i = 0; i < 70; i += 1) {
    const x = (i * 137.5) % width;
    const y = (i * 71.3) % (height * 0.5);
    const r = 1.2 + ((i * 37) % 3) * 0.6;
    stars.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}"/>`);
  }

  const circle = (cx: number, cy: number, r: number): string =>
    `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
  const moon = `<path fill-rule="evenodd" d="${circle(880, 95, 62)} ${circle(908, 89, 32)}"/>`;

  const farRange =
    'M 0 380 L 120 250 L 220 330 L 340 210 L 460 320 L 560 240 L 700 340 L 820 230 L 940 330 L 1000 280 L 1000 620 L 0 620 Z';
  const nearRange =
    'M 0 470 L 90 360 L 180 440 L 300 330 L 420 450 L 540 380 L 660 470 L 780 370 L 900 460 L 1000 400 L 1000 620 L 0 620 Z';
  const mountains = `<path d="${farRange}" opacity="0.55"/><path d="${nearRange}" opacity="0.8"/>`;

  const pine = (bx: number, base: number, h: number, w: number): string =>
    `<path d="M ${bx} ${base - h} L ${bx + w} ${base} L ${bx - w} ${base} Z"/>`;
  const pines = [
    pine(70, 600, 150, 42),
    pine(150, 620, 190, 54),
    pine(940, 600, 150, 42),
    pine(860, 620, 190, 54),
  ].join('');

  const pumaPath = `${smoothClosedPath(pumaMain)}${polygon(pumaFarHind)}${polygon(pumaFarFront)}`;
  const puma = `<g transform="translate(170,320) scale(0.72)"><path d="${pumaPath}"/></g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round">${stars.join('')}${moon}${mountains}${puma}${pines}</g></svg>`;
}

/**
 * Contour lines built from periodic sine sums so every path meets itself with
 * matching position and slope at the tile edges. Rows are spaced so the tile
 * height is an exact multiple of the row pitch, keeping the pattern seamless
 * both horizontally and vertically when it repeats.
 */
function topoSvg(): string {
  const width = 520;
  const height = 480;
  const rows = 16;
  const step = height / rows;
  const samples = 96;
  const paths: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    const base = r * step;
    const phase = (r / rows) * Math.PI * 2;
    const amp1 = 18 + 6 * Math.sin(phase);
    const amp2 = 9 + 4 * Math.cos(phase);
    let d = '';
    for (let s = 0; s <= samples; s += 1) {
      const x = (s / samples) * width;
      const y =
        base +
        amp1 * Math.sin((2 * Math.PI * s) / samples) +
        amp2 * Math.sin((4 * Math.PI * s) / samples + phase);
      d += `${s === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    paths.push(`<path d="${d.trim()}" fill="none" stroke="#fff" stroke-width="1.4"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths.join('')}</svg>`;
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

/** Vertical, wavy curtains of light used to shape the aurora preset. */
function auroraSvg(): string {
  const width = 1000;
  const height = 600;
  const curtains = 5;
  const wave = (base: number, index: number): string => {
    const top = base + (index % 2 ? 40 : -30);
    const mid = base + (index % 2 ? 90 : -80);
    const mid2 = base + (index % 3 ? 80 : -70);
    const bottom = base + (index % 2 ? -50 : 60);
    return `M ${top} -40 C ${mid} ${height * 0.32}, ${mid2} ${height * 0.6}, ${bottom} ${height + 40}`;
  };
  const parts: string[] = [];
  for (let i = 0; i < curtains; i += 1) {
    parts.push(
      `<path d="${wave(70 + i * 210, i)}" fill="none" stroke="#fff" stroke-width="${100 + (i % 3) * 40}" stroke-linecap="round" opacity="0.12"/>`,
    );
  }
  for (let i = 0; i < curtains; i += 1) {
    for (let j = 0; j < 6; j += 1) {
      const base = 70 + i * 210 + (j - 2.5) * 17;
      const opacity = (0.2 + ((i * 7 + j * 3) % 5) * 0.07).toFixed(2);
      parts.push(
        `<path d="${wave(base, i)}" fill="none" stroke="#fff" stroke-width="${1.5 + (j % 3)}" stroke-linecap="round" opacity="${opacity}"/>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
}

/** Jittered node grid with connecting links, used to shape the mesh preset. */
function networkSvg(): string {
  const width = 600;
  const height = 600;
  const step = 100;
  const jitter = (i: number, j: number): number => {
    const value = Math.sin(i * 37.3 + j * 91.7) * 43758.5453;
    return (value - Math.floor(value)) * 34 - 17;
  };
  const points: [number, number][][] = [];
  for (let i = 0; i <= 6; i += 1) {
    points[i] = [];
    for (let j = 0; j <= 6; j += 1) {
      points[i][j] = [
        Math.min(width - 6, Math.max(6, i * step + jitter(i, j))),
        Math.min(height - 6, Math.max(6, j * step + jitter(i + 9, j))),
      ];
    }
  }
  const lines: string[] = [];
  const nodes: string[] = [];
  for (let i = 0; i <= 6; i += 1) {
    for (let j = 0; j <= 6; j += 1) {
      const [x, y] = points[i][j];
      const px = x.toFixed(1);
      const py = y.toFixed(1);
      nodes.push(`<circle cx="${px}" cy="${py}" r="5"/>`);
      if (i < 6) {
        const [nx, ny] = points[i + 1][j];
        lines.push(`<line x1="${px}" y1="${py}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"/>`);
      }
      if (j < 6) {
        const [nx, ny] = points[i][j + 1];
        lines.push(`<line x1="${px}" y1="${py}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"/>`);
      }
      if (i < 6 && j < 6 && (i + j) % 2 === 0) {
        const [nx, ny] = points[i + 1][j + 1];
        lines.push(`<line x1="${px}" y1="${py}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g stroke="#fff" stroke-width="1.6" fill="none">${lines.join('')}</g><g fill="#fff">${nodes.join('')}</g></svg>`;
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
      image:
        'linear-gradient(180deg, #e879f9 0%, #a78bfa 12%, #22d3ee 30%, #34d399 52%, #4ade80 68%, rgba(74,222,128,0) 95%)',
      mask: svgUrl(auroraSvg()),
      maskSize: 'cover',
      maskPosition: 'center top',
      maskRepeat: 'no-repeat',
      opacity: 0.8,
    },
    preview: { maskSize: 'cover', maskPosition: 'center' },
  },
  {
    id: 'mesh',
    labelKey: 'settings.background.presets.mesh',
    scheme: 'any',
    style: {
      image: `linear-gradient(135deg, ${DIM_ACCENT(70)}, ${DIM_NAVY(80)})`,
      mask: svgUrl(networkSvg()),
      maskSize: 'cover',
      maskPosition: 'center',
      maskRepeat: 'no-repeat',
      opacity: 0.4,
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
    id: 'puma-night',
    labelKey: 'settings.background.presets.pumaNight',
    scheme: 'any',
    style: {
      image: `linear-gradient(165deg, ${DIM_ACCENT(75)}, ${DIM_NAVY(85)})`,
      mask: svgUrl(mountainNightSvg()),
      maskSize: 'auto 100%',
      maskPosition: 'center',
      maskRepeat: 'no-repeat',
      opacity: 0.4,
    },
    preview: { maskSize: 'contain' },
  },
];

export function findBackground(id: string | null | undefined): BackgroundPreset | null {
  if (!id || id === BACKGROUND_NONE || id === BACKGROUND_CUSTOM) {
    return null;
  }
  return BACKGROUND_PRESETS.find((preset) => preset.id === id) ?? null;
}
