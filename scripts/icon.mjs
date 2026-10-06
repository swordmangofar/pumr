/**
 * pumr icon source.
 *
 * The marks are chunky pixel grids. `mascot`, the sitting puma the app shows
 * while it is idle, is the default; `classic`, the big-cat face that shipped
 * first, stays available as a logo the user can pick in the settings. The
 * vector logos further down are smooth redrawings of the sitting puma, offered
 * in the settings as well. Everything downstream (favicon, in-app logos, Tauri
 * platform icons) is derived from this file.
 *
 *   node scripts/icon.mjs
 *
 * writes design/*.svg + public/logo*.svg. Run scripts/icon-build.mjs afterwards
 * to regenerate the bundled platform icons and favicon.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const palette = {
  navy: '#1e293b',
  accent: '#f59e0b',
};

/* ----------------------------------------------------------------- marks -- */

/**
 * The sitting puma, side on: ears and head top right, tail curling out at the
 * bottom left. The same drawing as `SIT_FRAME_DATA` in
 * src/app/core/puma-art.ts, so the app icon and the mascot inside the app
 * match; keep the two in step.
 */
export const mascotGrid = [
  '.............#..#.....',
  '.............##.##....',
  '............######....',
  '............#######...',
  '............#######...',
  '............########..',
  '............########..',
  '............#######...',
  '...........#######....',
  '...........#######....',
  '..........########....',
  '.........#########....',
  '.........#########....',
  '........##########....',
  '.......###########....',
  '......############....',
  '.....#############....',
  '....##############....',
  '....##############....',
  '.#################....',
  '##.###############....',
  '##.########.######....',
  '##..######..##.###....',
  '.###.####...##.##.....',
  '...####.....##.#......',
  '.....###..............',
];

/**
 * Front view of a big-cat face. `#` is the amber silhouette, `o` the navy
 * detail. Symmetric about the centre column: pointed ears sit in the top
 * corners, a dark stripe marks the forehead, angled eyes are set either side of
 * the muzzle, and rosette spots speckle the cheeks. The nose runs down into the
 * muzzle with a dark mouth line and a rounded chin.
 */
export const classicGrid = [
  '##.........................##',
  '####........#####........####',
  '#####....###########....#####',
  '######.######ooo######.######',
  '.########oo##ooo##oo########.',
  '.############ooo############.',
  '.#####oo##o#######o##oo#####.',
  '..###ooo#oo#######oo#ooo###..',
  '..#######oo#######oo#######..',
  '..#o#####################o#..',
  '.####ooooo#########ooooo####.',
  '.###o#o#ooo#######ooo#o#o###.',
  '.##oo##oooo#######oooo##oo##.',
  '###o####ooo#######ooo####o###',
  '#############################',
  '#####o#####o#####o#####o#####',
  '##oo#######o#####o#######oo##',
  '##oo##o####ooooooo####o##oo##',
  '############ooooo############',
  '.###o###o####ooo####o###o###.',
  '.###oo########o########oo###.',
  '..######oo####o####oo######..',
  '....#####o##ooooo##o#####....',
  '......####ooo###ooo####......',
  '.........###########.........',
  '..........#########..........',
  '............#####............',
];

/** Every logo by id. The ids match the `logo` setting. */
export const marks = { mascot: mascotGrid, classic: classicGrid };

/** The mark the bundled app icon, the favicon and a fresh install use. */
export const DEFAULT_MARK = 'mascot';

/** Tight bounds of a mark in grid units, used for centring. */
export function boundsOf(grid) {
  let minX = grid[0].length;
  let minY = grid.length;
  let maxX = 0;
  let maxY = 0;

  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] !== '.') {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  });

  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/* ---------------------------------------------------------------- paths -- */

/**
 * Emits one rectangle command per horizontal run of `char`, so a row of pixels
 * becomes a single `M..h..v1h-..Z` instead of one command per cell. Keeps the
 * SVG compact while staying on the exact pixel grid.
 */
function runsPath(grid, char) {
  const commands = [];

  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== char) {
        x += 1;
        continue;
      }
      let end = x;
      while (end + 1 < row.length && row[end + 1] === char) end += 1;
      const width = end - x + 1;
      commands.push(`M${x} ${y}h${width}v1h-${width}Z`);
      x = end + 1;
    }
  });

  return commands.join(' ');
}

/** Amber silhouette. */
export function silhouettePath(grid) {
  return runsPath(grid, '#');
}

/** Navy detail, such as eyes and nose. Empty for a plain silhouette. */
export function featurePath(grid) {
  return runsPath(grid, 'o');
}

/* ------------------------------------------------------- apple squircle -- */

const n = (v) => Number(v.toFixed(2));

/**
 * Superellipse |x/a|^5 + |y/a|^5 = 1. At 45 degrees this lands within a pixel
 * of the macOS Big Sur icon shape (an 824 square with ~185 continuous
 * corners), so it is exact by construction instead of eyeballed.
 */
function squirclePath(size, exponent = 5, steps = 128) {
  const a = size / 2;
  const points = [];

  for (let i = 0; i < steps * 4; i += 1) {
    const t = (i / (steps * 4)) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    points.push(
      `${n(Math.sign(c) * a * Math.abs(c) ** (2 / exponent))} ` +
        `${n(Math.sign(s) * a * Math.abs(s) ** (2 / exponent))}`,
    );
  }

  return `M${points[0]} L${points.slice(1).join(' L')} Z`;
}

/* ------------------------------------------------------------- documents -- */

function markPaths(grid) {
  const feature = featurePath(grid);
  return (
    `<path fill="${palette.accent}" d="${silhouettePath(grid)}" />` +
    (feature ? `\n    <path fill="${palette.navy}" d="${feature}" />` : '')
  );
}

function markGroup(grid, transform) {
  return `<g transform="${transform}">
    ${markPaths(grid)}
  </g>`;
}

/** Fits a mark into `box` pixels of a `size` canvas, centred on its bounds. */
export function fitTransform(grid, size, box) {
  const bounds = boundsOf(grid);
  const k = box / Math.max(bounds.width, bounds.height);
  return {
    k,
    tx: (size - bounds.width * k) / 2 - bounds.x * k,
    ty: (size - bounds.height * k) / 2 - bounds.y * k,
  };
}

function fit(grid, size, box) {
  const { k, tx, ty } = fitTransform(grid, size, box);
  return `translate(${n(tx)} ${n(ty)}) scale(${n(k)})`;
}

const svgOpen = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
  `viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"`;

/** Mark alone on transparency. Favicon and in-app logo. */
export function freeStandingSvg(grid, size = 512) {
  return `${svgOpen(size)} role="img" aria-labelledby="pumr-title">
  <title id="pumr-title">pumr</title>
  ${markGroup(grid, fit(grid, size, size * 0.94))}
</svg>
`;
}

/** Full-bleed navy tile, for the places transparency is unwelcome. */
export function tileSvg(grid, size = 1024) {
  return `${svgOpen(size)}>
  <rect width="${size}" height="${size}" rx="${n(size * 0.1875)}" fill="${palette.navy}" />
  ${markGroup(grid, fit(grid, size, size * 0.62))}
</svg>
`;
}

/**
 * macOS master: 1024 canvas, 824 squircle. The 100px margin is Apple's icon
 * grid, so the dock renders pumr at the same visual weight as system apps
 * instead of looking oversized next to them.
 */
export function macOsSvg(grid, size = 1024) {
  const plate = size * (824 / 1024);

  return `${svgOpen(size)}>
  <g transform="translate(${n(size / 2)} ${n(size / 2)})">
    <path fill="${palette.navy}" d="${squirclePath(plate)}" />
  </g>
  ${markGroup(grid, fit(grid, size, plate * 0.68))}
</svg>
`;
}

/* ------------------------------------------------------------ dev badge -- */

/** Crimson ribbon + white block letters, so a dev build is obvious at a glance. */
export const devPalette = {
  ribbon: '#ef4444',
  ink: '#ffffff',
};

/** 5x7 pixel glyphs in the same chunky spirit as the mark. */
const DEV_FONT = {
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
};

const DEV_TEXT = 'DEV';
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_GAP = 1;

/**
 * "DEV" as a run of unit rectangles centred on the origin. Letters are vector
 * rectangles rather than `<text>`, so the rasteriser never needs a font.
 */
function devText() {
  const letters = [...DEV_TEXT];
  const width = letters.length * GLYPH_WIDTH + (letters.length - 1) * GLYPH_GAP;
  const commands = [];

  letters.forEach((letter, index) => {
    const originX = index * (GLYPH_WIDTH + GLYPH_GAP);

    DEV_FONT[letter].forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (row[x] !== '1') {
          x += 1;
          continue;
        }
        let end = x;
        while (end + 1 < row.length && row[end + 1] === '1') end += 1;
        const run = end - x + 1;
        commands.push(`M${originX + x} ${y}h${run}v1h-${run}Z`);
        x = end + 1;
      }
    });
  });

  return { d: commands.join(' '), width, height: GLYPH_HEIGHT };
}

/**
 * macOS master with a "DEV" banderole across the base of the plate, clipped to
 * the squircle so the rounded corners stay clean. Used only by `tauri dev`.
 */
export function macOsDevSvg(grid, size = 1024) {
  const plate = size * (824 / 1024);
  const centre = size / 2;
  const bannerTop = size * 0.775;
  const bannerHeight = size * 0.125;
  const bannerCentre = bannerTop + bannerHeight / 2;
  const text = devText();
  const scale = (bannerHeight * 0.52) / text.height;

  const mark = `<g shape-rendering="crispEdges" transform="${fit(grid, size, plate * 0.68)}">
    ${markPaths(grid)}
  </g>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" role="img" aria-labelledby="pumr-dev-title">
  <title id="pumr-dev-title">pumr (dev)</title>
  <defs>
    <clipPath id="pumr-plate">
      <path transform="translate(${n(centre)} ${n(centre)})" d="${squirclePath(plate)}" />
    </clipPath>
  </defs>
  <g transform="translate(${n(centre)} ${n(centre)})">
    <path fill="${palette.navy}" d="${squirclePath(plate)}" />
  </g>
  ${mark}
  <g clip-path="url(#pumr-plate)">
    <rect x="0" y="${n(bannerTop)}" width="${size}" height="${n(bannerHeight)}" fill="${devPalette.ribbon}" />
    <g transform="translate(${n(centre)} ${n(bannerCentre)}) scale(${n(scale)}) translate(${n(-text.width / 2)} ${n(-text.height / 2)})">
      <path fill="${devPalette.ink}" d="${text.d}" />
    </g>
  </g>
</svg>
`
  );
}

/* --------------------------------------------------------- vector logos -- */

/**
 * The sitting puma redrawn with curves, for the logos that are not pixel art.
 * It faces right in a 232 x 256 box; the outline runs clockwise from the nape.
 */
const pumaOutline = [
  'M152 66',
  'C152 56 154 48 158 42', // back of the skull
  'Q160 28 167 20 Q174 24 178 32', // rear ear
  'Q181 25 190 19 Q196 24 199 32', // front ear
  'C205 33 210 37 213 42', // forehead
  'C216 47 222 50 224 55', // nose bridge
  'C226 58 226 61 224 63', // nose
  'C223 65 223 67 224 70', // lip
  'C225 75 222 81 216 83', // chin
  'C210 85 205 86 203 91', // jaw
  'C202 102 203 118 205 131', // throat
  'C207 144 207 166 206 186', // chest
  'C205 206 205 226 206 240', // front leg
  'C207 244 214 244 214 248 C214 251 212 252 209 252', // paw
  'L188 252 C185 252 183 250 183 247',
  'L183 202 C183 192 176 190 173 198', // gap behind the front leg
  'L162 246 C161 250 159 252 155 252',
  'L116 252 C94 252 78 240 76 216', // rump
  'C74 188 86 160 106 138', // back
  'C122 120 140 102 148 78', // shoulders
  'C150 74 152 70 152 66Z',
].join('');

const pumaEye = 'M203 48Q209 42 216 48Q209 51 203 48Z';

/** Tail centre lines, stroked `TAIL_WIDTH` wide with round ends. */
const TAIL_WIDTH = 17;
const pumaTails = {
  ground: 'M100 241C76 247 40 248 24 234C12 223 12 208 24 200',
  raised: 'M100 241C72 249 36 246 30 218C25 195 47 180 45 156C44 142 35 134 25 137',
};

export const vectorPalette = {
  tileTop: '#243247',
  tileBottom: '#0f172a',
  amberTop: '#fbbf24',
  amberBottom: '#f08c00',
};

/**
 * Puma colouring, painted over the amber: light on the muzzle and chest, a
 * darker back, the far ear in shade and the dark tail tip a puma has.
 */
const pumaShade = `<linearGradient id="puma-light" gradientUnits="userSpaceOnUse" x1="182" y1="0" x2="228" y2="0">
      <stop offset="0" stop-color="#fff3c4" stop-opacity="0" />
      <stop offset="1" stop-color="#fff3c4" stop-opacity="0.6" />
    </linearGradient>
    <linearGradient id="puma-dark" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="156" y2="0">
      <stop offset="0" stop-color="#a34a06" stop-opacity="0.6" />
      <stop offset="1" stop-color="#a34a06" stop-opacity="0" />
    </linearGradient>
    <rect x="-40" y="0" width="200" height="260" fill="url(#puma-dark)" />
    <rect x="176" y="0" width="64" height="260" fill="url(#puma-light)" />
    <path d="M156 46Q160 28 167 20Q174 24 178 32L174 46Z" fill="#c2670a" />
    <path d="M17 212C17 207 20 203 24 200" fill="none" stroke="#6f3805" stroke-width="20" stroke-linecap="round" />`;

/**
 * Logos drawn as vectors, by the id used in the `logo` setting. `bounds` is
 * the tight box of the drawing, tail included.
 */
export const vectorLogos = {
  shaded: {
    tail: pumaTails.ground,
    eye: true,
    shade: true,
    bounds: { x: 6.5, y: 19, width: 219, height: 234.7 },
  },
  tailup: {
    tail: pumaTails.raised,
    eye: false,
    shade: false,
    bounds: { x: 16.5, y: 19, width: 209, height: 234.4 },
  },
};

/**
 * The puma in its own 232 x 256 box. The silhouette is a mask, so one amber
 * gradient runs across body and tail and the eye is a real hole.
 */
function pumaDrawing(logo) {
  return `<defs>
    <linearGradient id="puma-amber" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${vectorPalette.amberTop}" />
      <stop offset="1" stop-color="${vectorPalette.amberBottom}" />
    </linearGradient>
    <mask id="puma" maskUnits="userSpaceOnUse" x="-40" y="-40" width="312" height="336">
      <path d="${pumaOutline}" fill="#fff" />
      <path d="${logo.tail}" fill="none" stroke="#fff" stroke-width="${TAIL_WIDTH}" stroke-linecap="round" />${
        logo.eye ? `\n      <path d="${pumaEye}" fill="#000" />` : ''
      }
    </mask>
  </defs>
  <g mask="url(#puma)">
    <rect x="-40" y="14" width="312" height="240" fill="url(#puma-amber)" />${
      logo.shade ? `\n    ${pumaShade}` : ''
    }
  </g>`;
}

const vectorOpen = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
  `viewBox="0 0 ${size} ${size}"`;

/** Vector logo alone on transparency, centred on its bounds. In-app logo. */
export function vectorFreeStandingSvg(logo, size = 512) {
  const { x, y, width, height } = logo.bounds;
  const k = (size * 0.94) / Math.max(width, height);
  const tx = (size - width * k) / 2 - x * k;
  const ty = (size - height * k) / 2 - y * k;

  return `${vectorOpen(size)} role="img" aria-labelledby="pumr-title">
  <title id="pumr-title">pumr</title>
  <g transform="translate(${n(tx)} ${n(ty)}) scale(${n(k)})">
  ${pumaDrawing(logo)}
  </g>
</svg>
`;
}

/**
 * Where the puma sits on a 512 tile: a little left of centre, so the head on
 * the right balances the thin tail on the left.
 */
const PUMA_ON_TILE = 'translate(72 58) scale(1.5)';

/**
 * macOS master for a vector logo: the same 824 squircle on a 1024 canvas as
 * the pixel marks, with a navy gradient instead of the flat plate.
 */
export function vectorMacOsSvg(logo, size = 1024) {
  const plate = size * (824 / 1024);
  const edge = (size - plate) / 2;

  return `${vectorOpen(size)}>
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${vectorPalette.tileTop}" />
      <stop offset="1" stop-color="${vectorPalette.tileBottom}" />
    </linearGradient>
  </defs>
  <g transform="translate(${n(size / 2)} ${n(size / 2)})">
    <path fill="url(#plate)" d="${squirclePath(plate)}" />
  </g>
  <g transform="translate(${n(edge)} ${n(edge)}) scale(${n(plate / 512)}) ${PUMA_ON_TILE}">
  ${pumaDrawing(logo)}
  </g>
</svg>
`;
}

/* ----------------------------------------------------------------- write -- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = (rel, contents) => {
    const target = resolve(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    console.log(`wrote ${rel}`);
  };

  // The default mark keeps the plain file names the bundler and README use.
  const main = marks[DEFAULT_MARK];
  out('design/icon-macos.svg', macOsSvg(main, 1024));
  out('design/icon-macos-dev.svg', macOsDevSvg(main, 1024));
  out('design/icon-tile.svg', tileSvg(main, 1024));
  out('design/icon-mark.svg', freeStandingSvg(main, 1024));
  out('public/logo.svg', freeStandingSvg(main, 512));

  // Every mark also gets an id-suffixed logo, which is what the app loads.
  for (const [id, grid] of Object.entries(marks)) {
    out(`public/logo-${id}.svg`, freeStandingSvg(grid, 512));
    if (id === DEFAULT_MARK) continue;
    out(`design/icon-macos-${id}.svg`, macOsSvg(grid, 1024));
    out(`design/icon-tile-${id}.svg`, tileSvg(grid, 1024));
    out(`design/icon-mark-${id}.svg`, freeStandingSvg(grid, 1024));
  }

  for (const [id, logo] of Object.entries(vectorLogos)) {
    out(`public/logo-${id}.svg`, vectorFreeStandingSvg(logo, 512));
    out(`design/icon-macos-${id}.svg`, vectorMacOsSvg(logo, 1024));
    out(`design/icon-mark-${id}.svg`, vectorFreeStandingSvg(logo, 1024));
  }
}
