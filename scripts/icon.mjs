/**
 * pumr icon source.
 *
 * The puma is defined once as a chunky pixel grid -- a side view of the head
 * looking left, drawn in the same silhouette style as the loading animation.
 * Everything downstream (favicon, in-app logo, Tauri platform icons) is
 * derived from this file.
 *
 *   node scripts/icon.mjs
 *
 * writes design/*.svg + public/logo.svg. Run scripts/icon-build.mjs afterwards
 * to regenerate the bundled platform icons and favicon.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const palette = {
  navy: '#14213d',
  accent: '#fca311',
};

/* ------------------------------------------------------------------ mark -- */

/**
 * Side view of a puma head facing left. `#` is the amber silhouette, `o` the
 * navy detail (eye and nose). Two blunt-tipped ears rise clear of the crown,
 * with the near ear in front and the far ear peeking out behind it, matching
 * the loader sprite. The muzzle steps out to the lower left so the profile
 * reads as a big cat rather than a generic blob.
 */
export const headGrid = [
  '..................................',
  '..................................',
  '.............##...................',
  '.............##.....##............',
  '............####....##............',
  '............######.####...........',
  '...........############...........',
  '...........############...........',
  '..........##############..........',
  '..........##############..........',
  '.........################.........',
  '.........################.........',
  '.......######oo##########.........',
  '......######oo###########.........',
  '.....####################.........',
  '.....#o##################.........',
  '.....#o#################..........',
  '......#################...........',
  '.......###############............',
  '.......##############.............',
  '.......###########................',
  '.........#######..................',
  '..................................',
  '..................................',
  '..................................',
  '..................................',
  '..................................',
  '..................................',
  '..................................',
  '..................................',
];

const GRID_WIDTH = headGrid[0].length;
const GRID_HEIGHT = headGrid.length;

/** Tight bounds of the mark in grid units, used for centring. */
export const markBounds = (() => {
  let minX = GRID_WIDTH;
  let minY = GRID_HEIGHT;
  let maxX = 0;
  let maxY = 0;

  headGrid.forEach((row, y) => {
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
})();

/* ---------------------------------------------------------------- paths -- */

/**
 * Emits one rectangle command per horizontal run of `char`, so a row of pixels
 * becomes a single `M..h..v1h-..Z` instead of one command per cell. Keeps the
 * SVG compact while staying on the exact pixel grid.
 */
function runsPath(char) {
  const commands = [];

  headGrid.forEach((row, y) => {
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
export function silhouettePath() {
  return runsPath('#');
}

/** Navy detail: eye and nose. */
export function featurePath() {
  return runsPath('o');
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

function markGroup(transform) {
  return `<g transform="${transform}">
    <path fill="${palette.accent}" d="${silhouettePath()}" />
    <path fill="${palette.navy}" d="${featurePath()}" />
  </g>`;
}

/** Fits the mark into `box` pixels of a `size` canvas, optically centred. */
export function fitTransform(size, box) {
  const k = box / Math.max(markBounds.width, markBounds.height);
  return {
    k,
    tx: (size - markBounds.width * k) / 2 - markBounds.x * k,
    ty: (size - markBounds.height * k) / 2 - markBounds.y * k,
  };
}

function fit(size, box) {
  const { k, tx, ty } = fitTransform(size, box);
  return `translate(${n(tx)} ${n(ty)}) scale(${n(k)})`;
}

const svgOpen = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
  `viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"`;

/** Mark alone on transparency. Favicon and in-app logo. */
export function freeStandingSvg(size = 512) {
  return `${svgOpen(size)} role="img" aria-labelledby="pumr-title">
  <title id="pumr-title">pumr</title>
  ${markGroup(fit(size, size * 0.94))}
</svg>
`;
}

/** Full-bleed navy tile, for the places transparency is unwelcome. */
export function tileSvg(size = 1024) {
  return `${svgOpen(size)}>
  <rect width="${size}" height="${size}" rx="${n(size * 0.1875)}" fill="${palette.navy}" />
  ${markGroup(fit(size, size * 0.62))}
</svg>
`;
}

/**
 * macOS master: 1024 canvas, 824 squircle. The 100px margin is Apple's icon
 * grid, so the dock renders pumr at the same visual weight as system apps
 * instead of looking oversized next to them.
 */
export function macOsSvg(size = 1024) {
  const plate = size * (824 / 1024);

  return `${svgOpen(size)}>
  <g transform="translate(${n(size / 2)} ${n(size / 2)})">
    <path fill="${palette.navy}" d="${squirclePath(plate)}" />
  </g>
  ${markGroup(fit(size, plate * 0.68))}
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

  out('design/icon-macos.svg', macOsSvg(1024));
  out('design/icon-tile.svg', tileSvg(1024));
  out('design/icon-mark.svg', freeStandingSvg(1024));
  out('public/logo.svg', freeStandingSvg(512));
}
