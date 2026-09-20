/**
 * pumr icon rasteriser + bundler.
 *
 * Renders the pixel grid from scripts/icon.mjs straight to PNGs with a
 * dependency-free encoder, so the chunky pixels stay crisp at every size
 * instead of being blurred by a generic SVG rasteriser. Then hands a 1024px
 * master to the Tauri CLI, which regenerates the platform icon set, and
 * writes public/favicon.ico.
 *
 *   node scripts/icon.mjs        # refresh the SVG sources first
 *   node scripts/icon-build.mjs  # rasterise + bundle
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { fitTransform, headGrid, markBounds, palette } from './icon.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------- png -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Minimal RGBA PNG (8-bit, non-interlaced) writer. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * stride + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const ACCENT = rgb(palette.accent);
const NAVY = rgb(palette.navy);

/**
 * Point-samples the mark grid into a `size` square, fitting it to `box`
 * pixels. Point sampling (rather than resampling the 1024 master) is what
 * keeps the pixels hard-edged at small sizes.
 */
function renderMark(size, box) {
  const { k, tx, ty } = fitTransform(size, box);
  const rgba = new Uint8Array(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const gx = Math.floor((px - tx) / k);
      const gy = Math.floor((py - ty) / k);
      const cell = headGrid[gy]?.[gx];
      const i = (py * size + px) * 4;

      const colour = cell === '#' ? ACCENT : cell === 'o' ? NAVY : null;

      if (colour) {
        rgba[i] = colour[0];
        rgba[i + 1] = colour[1];
        rgba[i + 2] = colour[2];
        rgba[i + 3] = 255;
      }
    }
  }

  return encodePng(size, size, rgba);
}

/**
 * Renders the mark on the navy macOS squircle. The mark stays point-sampled so
 * the pixels stay hard; the plate edge is antialiased (4x4 coverage) so the
 * corners stay smooth at small sizes, the way system icons look.
 */
const PLATE_RATIO = 824 / 1024; // Apple's icon grid: 100px margin on 1024
const PLATE_MARK = 0.68; // mark as a fraction of the plate
const PLATE_EXPONENT = 5; // superellipse |x/a|^5 + |y/a|^5 = 1
const SUBSAMPLES = 4;

function renderPlate(size) {
  const plate = size * PLATE_RATIO;
  const half = plate / 2;
  const { k, tx, ty } = fitTransform(size, plate * PLATE_MARK);
  const rgba = new Uint8Array(size * size * 4);
  const step = 1 / SUBSAMPLES;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const i = (py * size + px) * 4;
      const gx = Math.floor((px - tx) / k);
      const gy = Math.floor((py - ty) / k);
      const cell = headGrid[gy]?.[gx];

      if (cell === '#' || cell === 'o') {
        const colour = cell === '#' ? ACCENT : NAVY;
        rgba[i] = colour[0];
        rgba[i + 1] = colour[1];
        rgba[i + 2] = colour[2];
        rgba[i + 3] = 255;
        continue;
      }

      let hits = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
        for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
          const x = Math.abs((px + (sx + 0.5) * step - size / 2) / half);
          const y = Math.abs((py + (sy + 0.5) * step - size / 2) / half);
          if (x ** PLATE_EXPONENT + y ** PLATE_EXPONENT <= 1) hits += 1;
        }
      }

      if (hits > 0) {
        rgba[i] = NAVY[0];
        rgba[i + 1] = NAVY[1];
        rgba[i + 2] = NAVY[2];
        rgba[i + 3] = Math.round((hits / SUBSAMPLES ** 2) * 255);
      }
    }
  }

  return encodePng(size, size, rgba);
}

/** ICO container with PNG-compressed entries (Vista and later). */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;

  images.forEach(({ size, png }, i) => {
    const entry = i * 16;
    directory[entry] = size >= 256 ? 0 : size;
    directory[entry + 1] = size >= 256 ? 0 : size;
    directory[entry + 2] = 0; // palette
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

/* ----------------------------------------------------------------- build -- */

/**
 * The Tauri CLI smooth-resizes its input, which softens the hard pixel edges
 * at small sizes. So let it handle the platform sets that need its layout
 * rules (iOS, Android), then overwrite every desktop raster with a
 * point-sampled render of our own.
 */
const DESKTOP_PNGS = {
  '32x32.png': 32,
  '64x64.png': 64,
  '128x128.png': 128,
  '128x128@2x.png': 256,
  'icon.png': 512,
};

const APPX_PNGS = {
  'StoreLogo.png': 50,
  'Square30x30Logo.png': 30,
  'Square44x44Logo.png': 44,
  'Square71x71Logo.png': 71,
  'Square89x89Logo.png': 89,
  'Square107x107Logo.png': 107,
  'Square142x142Logo.png': 142,
  'Square150x150Logo.png': 150,
  'Square284x284Logo.png': 284,
  'Square310x310Logo.png': 310,
};

const ICO_SIZES = [16, 24, 32, 48, 64, 256];
const FAVICON_SIZES = [16, 24, 32, 48, 64, 256];

/** `iconutil` iconset members: [filename, pixel size]. */
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

/** Free-standing mark on transparency (favicon, mobile master). */
const renderMarkAt = (size) => renderMark(size, size * 0.94);

function buildFavicon() {
  const images = FAVICON_SIZES.map((size) => ({ size, png: renderMarkAt(size) }));
  writeFileSync(resolve(root, 'public/favicon.ico'), encodeIco(images));
  console.log(`wrote public/favicon.ico (${FAVICON_SIZES.join(', ')})`);
}

function buildPlatformIcons() {
  const dir = mkdtempSync(join(tmpdir(), 'pumr-icon-'));
  writeFileSync(join(dir, 'master.png'), renderMarkAt(1024));

  // The CLI's own resampling is smooth, which is fine for iOS/Android where
  // the mark is large or masked anyway. `bg_color` puts the mark on navy for
  // those platforms (the desktop rasters are overwritten below).
  const manifest = join(dir, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ default: 'master.png', bg_color: palette.navy }));

  const tauri = resolve(root, 'node_modules/.bin/tauri');
  execFileSync(tauri, ['icon', manifest], { cwd: root, stdio: 'inherit' });

  rmSync(dir, { recursive: true, force: true });
}

/** Replaces the smooth-resized desktop rasters with crisp point-sampled ones. */
function buildDesktopIcons() {
  const icons = resolve(root, 'src-tauri/icons');

  for (const [name, size] of Object.entries({ ...DESKTOP_PNGS, ...APPX_PNGS })) {
    writeFileSync(resolve(icons, name), renderPlate(size));
  }

  const ico = ICO_SIZES.map((size) => ({ size, png: renderPlate(size) }));
  writeFileSync(resolve(icons, 'icon.ico'), encodeIco(ico));
  console.log(`wrote src-tauri/icons/icon.ico (${ICO_SIZES.join(', ')})`);

  buildIcns(icons);
}

/**
 * macOS ships `iconutil`, which turns an `.iconset` folder into an icns that
 * includes the legacy raw 16/32px members as well as the modern PNG ones. Off
 * macOS we keep the CLI's own icns, which is only ever consumed on macOS.
 */
function buildIcns(icons) {
  if (process.platform !== 'darwin') {
    console.log('skipped icon.icns (needs macOS iconutil)');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'pumr-iconset-'));
  const set = join(dir, 'pumr.iconset');
  mkdirSync(set);

  for (const [name, size] of ICONSET) writeFileSync(join(set, name), renderPlate(size));
  execFileSync('iconutil', ['-c', 'icns', set, '-o', resolve(icons, 'icon.icns')]);

  rmSync(dir, { recursive: true, force: true });
  console.log('wrote src-tauri/icons/icon.icns (via iconutil)');
}

/**
 * Tauri bakes the icons into the binary at compile time via
 * `generate_context!`, but Cargo does not track `src-tauri/icons` as a
 * dependency, so an icon change alone never triggers a rebuild. Nudge the
 * crate that expands the macro so the next build picks the icons up -- without
 * this the macOS Dock keeps showing the previous icon.
 */
function touchContext() {
  const context = resolve(root, 'src-tauri/src/lib.rs');
  if (!existsSync(context)) return;

  const now = new Date();
  utimesSync(context, now, now);
  console.log('touched src-tauri/src/lib.rs to force an icon rebuild');
}

mkdirSync(resolve(root, 'src-tauri/icons'), { recursive: true });
buildFavicon();
buildPlatformIcons();
buildDesktopIcons();
touchContext();

console.log(`mark bounds ${markBounds.width}x${markBounds.height} (grid units)`);
