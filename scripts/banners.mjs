/**
 * README feature banners: one abstract illustration per feature section.
 *
 *   node scripts/banners.mjs
 *
 * writes docs/features/banner-*.svg. The screenshots next to them come from
 * `pnpm docs:screenshots`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'docs/features');

const W = 1120;
const H = 260;

const c = {
  amber: '#f59e0b',
  cyan: '#22d3ee',
  green: '#34d399',
  rose: '#fb7185',
  violet: '#a78bfa',
  text: '#e5e5e5',
  mute: '#94a3b8',
};

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/* -------------------------------------------------------------- helpers -- */

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const attrs = (props) =>
  Object.entries(props)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${value}"`)
    .join(' ');

const text = (x, y, value, props = {}) =>
  `<text ${attrs({ x, y, fontFamily: SANS, fontSize: 13, fill: c.text, ...props })}>${esc(value)}</text>`;

const mono = (x, y, value, props = {}) => text(x, y, value, { fontFamily: MONO, ...props });

/** Width of `label` at `size` px, close enough to size pills around it. */
const measure = (label, size, isMono) => label.length * size * (isMono ? 0.62 : 0.56);

/** A rounded capsule with an optional label; returns its width via `.w`. */
function pill(
  x,
  y,
  label,
  { color = c.text, fill, size = 12, isMono = true, h = 26, padX = 12, w } = {},
) {
  const width = w ?? Math.round(measure(label, size, isMono) + padX * 2);
  const bg = fill ?? color;
  const shape =
    `<rect ${attrs({ x, y, width, height: h, rx: h / 2, fill: bg, fillOpacity: 0.12, stroke: color, strokeOpacity: 0.45 })}/>` +
    (label
      ? (isMono ? mono : text)(x + width / 2, y + h / 2 + size * 0.36, label, {
          fontSize: size,
          fill: color,
          textAnchor: 'middle',
          fontWeight: isMono ? 500 : 600,
        })
      : '');
  return Object.assign(new String(shape), { w: width });
}

const line = (x1, y1, x2, y2, props = {}) =>
  `<line ${attrs({ x1, y1, x2, y2, stroke: 'url(#acc)', strokeWidth: 2, strokeOpacity: 0.55, strokeLinecap: 'round', ...props })}/>`;

const path = (d, props = {}) =>
  `<path ${attrs({ d, fill: 'none', stroke: 'url(#acc)', strokeWidth: 2, strokeOpacity: 0.55, strokeLinecap: 'round', ...props })}/>`;

const dot = (cx, cy, r, color, props = {}) =>
  `<circle ${attrs({ cx, cy, r, fill: color, ...props })}/>`;

const ring = (cx, cy, r, color) =>
  dot(cx, cy, r, color, { fillOpacity: 0.9 }) +
  dot(cx, cy, r + 5, 'none', { stroke: color, strokeOpacity: 0.25 });

const card = (x, y, width, height, props = {}) =>
  `<rect ${attrs({ x, y, width, height, rx: 12, fill: '#ffffff', fillOpacity: 0.04, stroke: '#ffffff', strokeOpacity: 0.1, ...props })}/>`;

/** Faint placeholder text lines inside cards. */
const bars = (x, y, widths, { gap = 12, color = c.text, opacity = 0.22, h = 4 } = {}) =>
  widths
    .map(
      (width, i) =>
        `<rect ${attrs({ x, y: y + i * gap, width, height: h, rx: h / 2, fill: color, fillOpacity: opacity })}/>`,
    )
    .join('');

const check = (x, y, color = c.green, size = 1) =>
  path(`M ${x - 6 * size} ${y} l ${4 * size} ${4 * size} l ${8 * size} ${-9 * size}`, {
    stroke: color,
    strokeOpacity: 1,
    strokeWidth: 2.5,
    strokeLinejoin: 'round',
  });

const cross = (x, y, color = c.rose) =>
  path(`M ${x - 5} ${y - 5} l 10 10 M ${x + 5} ${y - 5} l -10 10`, {
    stroke: color,
    strokeOpacity: 1,
    strokeWidth: 2.5,
  });

/* ---------------------------------------------------------------- frame -- */

function frame({ index, eyebrow, title, caption, art }) {
  const lines = title.split('\n');
  const titleY = lines.length > 1 ? 120 : 136;
  const captionY = titleY + (lines.length - 1) * 34 + 38;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${eyebrow}: ${title.replace('\n', ' ')}`)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1220"/>
      <stop offset="1" stop-color="#05070d"/>
    </linearGradient>
    <radialGradient id="glow" cx="82%" cy="12%" r="75%">
      <stop offset="0" stop-color="${c.amber}" stop-opacity="0.18"/>
      <stop offset="1" stop-color="${c.amber}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="10%" cy="110%" r="70%">
      <stop offset="0" stop-color="#1e293b" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#1e293b" stop-opacity="0"/>
    </radialGradient>
    <!-- User space, so straight horizontal lines (zero-height boxes) still paint. -->
    <linearGradient id="acc" gradientUnits="userSpaceOnUse" x1="420" y1="0" x2="1080" y2="0">
      <stop offset="0" stop-color="${c.amber}"/>
      <stop offset="1" stop-color="${c.cyan}"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${c.amber}"/>
      <stop offset="1" stop-color="${c.cyan}"/>
    </linearGradient>
    <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${c.amber}" fill-opacity="0.85"/>
    </marker>
    <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.25" fill="#ffffff" fill-opacity="0.05"/>
    </pattern>
    <clipPath id="frame"><rect width="${W}" height="${H}" rx="20"/></clipPath>
  </defs>
  <g clip-path="url(#frame)">
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect width="${W}" height="${H}" fill="url(#glow)"/>
    <rect width="${W}" height="${H}" fill="url(#glow2)"/>
    <rect width="${W}" height="${H}" fill="url(#dots)"/>
    ${mono(56, titleY - 42, `${String(index).padStart(2, '0')} / ${eyebrow}`, { fontSize: 12, fill: c.amber, letterSpacing: 2, fontWeight: 600 })}
    ${lines.map((row, i) => text(56, titleY + i * 34, row, { fontSize: 28, fontWeight: 700, fill: '#f8fafc' })).join('')}
    ${text(56, captionY, caption, { fontSize: 14, fill: c.mute })}
    <rect x="56" y="${captionY + 16}" width="44" height="4" rx="2" fill="url(#bar)"/>
    ${art}
  </g>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="20" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>
</svg>
`;
}

/* ------------------------------------------------------------- banners -- */

/** A prompt fans out into reasoning and tool calls, with a sub-agent branch. */
function agentChat() {
  const y = 128;
  const steps = [
    ['thinking', c.violet],
    ['read', c.cyan],
    ['grep', c.cyan],
    ['edit +17 −1', c.amber],
    ['bash', c.green],
  ];
  let x = 440;
  let chain = '';
  const centers = [];
  for (const [label, color] of steps) {
    const p = pill(x, y, label, { color });
    chain += p;
    centers.push(x + p.w / 2);
    x += p.w + 22;
    if (x < 1000) {
      chain += line(x - 20, y + 13, x - 4, y + 13, { strokeDasharray: '2 5' });
    }
  }
  const done = x + 12;
  return [
    // Prompt bubble.
    card(440, 46, 330, 44, {
      rx: 22,
      fill: c.amber,
      fillOpacity: 0.12,
      stroke: c.amber,
      strokeOpacity: 0.5,
    }),
    text(462, 73, 'Add a Stripe checkout and test it', { fontSize: 14, fill: '#fde68a' }),
    path(`M 470 92 C 470 110, ${centers[0]} 108, ${centers[0]} ${y - 2}`, {
      strokeDasharray: '2 6',
    }),
    chain,
    ring(done, y + 13, 9, c.green),
    check(done + 1, y + 13, '#05070d', 0.8),
    // Sub-agent branch.
    path(
      `M ${centers[2]} ${y + 28} C ${centers[2]} ${y + 64}, ${centers[2] + 20} ${y + 70}, ${centers[2] + 60} ${y + 70}`,
      {
        strokeDasharray: '2 6',
      },
    ),
    pill(centers[2] + 64, y + 57, 'sub-agent · test-runner', { color: c.violet }),
    // Live cost.
    card(820, 46, 240, 44, { rx: 22 }),
    mono(842, 73, '$0.31', { fontSize: 14, fill: c.green, fontWeight: 600 }),
    `<rect x="900" y="64" width="136" height="6" rx="3" fill="#ffffff" fill-opacity="0.1"/>`,
    `<rect x="900" y="64" width="22" height="6" rx="3" fill="${c.green}"/>`,
    text(900, 84, '$18.76 left of $20', { fontSize: 10, fill: c.mute }),
  ].join('');
}

/** Commands pass a gate: safe ones run, risky ones ask, dangerous ones stop. */
function toolsPermissions() {
  const gateX = 720;
  const rows = [
    ['ls src/routes', 'runs', c.green],
    ['pnpm test', 'runs', c.green],
    ['git push origin', 'asks', c.amber],
    ['rm -rf ~', 'blocked', c.rose],
  ];
  const art = [];
  rows.forEach(([command, outcome, color], i) => {
    const y = 40 + i * 48;
    const p = pill(440, y, `$ ${command}`, { color: c.text, fill: '#ffffff' });
    art.push(p);
    art.push(
      path(
        `M ${440 + p.w + 8} ${y + 13} C ${gateX - 60} ${y + 13}, ${gateX - 60} 130, ${gateX - 46} 130`,
        {
          strokeDasharray: '2 6',
          strokeOpacity: 0.35,
        },
      ),
    );
    const outY = 40 + i * 48 + 13;
    art.push(
      path(
        `M ${gateX + 46} 130 C ${gateX + 90} 130, ${gateX + 90} ${outY}, ${gateX + 120} ${outY}`,
        {
          stroke: color,
          strokeOpacity: 0.45,
          strokeDasharray: '2 6',
        },
      ),
    );
    art.push(ring(gateX + 136, outY, 9, color));
    if (outcome === 'runs') {
      art.push(check(gateX + 137, outY, '#05070d', 0.75));
    } else if (outcome === 'blocked') {
      art.push(cross(gateX + 136, outY, '#05070d'));
    } else {
      art.push(
        mono(gateX + 136, outY + 4, '?', {
          fontSize: 12,
          fill: '#05070d',
          textAnchor: 'middle',
          fontWeight: 700,
        }),
      );
    }
    if (outcome === 'asks') {
      let cx = gateX + 158;
      for (const choice of ['1 yes', '2 always', '3 no']) {
        const chip = pill(cx, outY - 12, choice, {
          color: choice.startsWith('3') ? c.rose : c.amber,
          h: 24,
          size: 11,
          padX: 9,
        });
        art.push(chip);
        cx += chip.w + 6;
      }
    } else {
      art.push(text(gateX + 158, outY + 4, outcome, { fontSize: 12, fill: color }));
    }
  });
  // Shield gate.
  const shield = `M ${gateX} 78 C ${gateX + 24} 84, ${gateX + 36} 86, ${gateX + 44} 90 L ${gateX + 40} 138 C ${gateX + 36} 168, ${gateX + 18} 182, ${gateX} 190 C ${gateX - 18} 182, ${gateX - 36} 168, ${gateX - 40} 138 L ${gateX - 44} 90 C ${gateX - 36} 86, ${gateX - 24} 84, ${gateX} 78 Z`;
  art.push(
    `<path d="${shield}" fill="${c.amber}" fill-opacity="0.12" stroke="${c.amber}" stroke-opacity="0.75" stroke-width="2.5"/>`,
  );
  art.push(check(gateX + 2, 134, c.amber, 1.3));
  return art.join('');
}

/** A shadow-git timeline of snapshots, a diff, and @ context chips. */
function diffsHistory() {
  const art = [];
  // Diff card.
  art.push(card(440, 40, 230, 180));
  art.push(mono(458, 64, 'checkout.ts', { fontSize: 12, fill: c.text, fillOpacity: 0.8 }));
  art.push(mono(652, 64, '+17 −1', { fontSize: 11, fill: c.green, textAnchor: 'end' }));
  const rows = [
    [0, 120],
    [0, 150],
    [-1, 132],
    [1, 142],
    [0, 90],
    [1, 170],
    [1, 128],
    [1, 154],
    [0, 100],
  ];
  rows.forEach(([kind, width], i) => {
    const y = 80 + i * 14;
    if (kind) {
      const color = kind > 0 ? c.green : c.rose;
      art.push(
        `<rect x="448" y="${y - 4}" width="214" height="12" fill="${color}" fill-opacity="0.1"/>`,
      );
      art.push(mono(454, y + 6, kind > 0 ? '+' : '−', { fontSize: 11, fill: color }));
    }
    art.push(
      bars(470, y, [width], {
        color: kind > 0 ? c.green : kind < 0 ? c.rose : c.text,
        opacity: kind ? 0.55 : 0.2,
      }),
    );
  });
  // Snapshot timeline.
  const y = 84;
  art.push(line(712, y, 1060, y, { strokeOpacity: 0.4 }));
  const snaps = [728, 800, 872, 944, 1016];
  snaps.forEach((x, i) => {
    const current = i === snaps.length - 1;
    art.push(
      current
        ? ring(x, y, 7, c.amber)
        : dot(x, y, 6, '#0b1220', { stroke: c.cyan, strokeWidth: 2, strokeOpacity: 0.8 }),
    );
    art.push(mono(x, y + 28, `#${i + 1}`, { fontSize: 11, fill: c.mute, textAnchor: 'middle' }));
  });
  art.push(
    path(`M 1012 ${y - 14} C 990 ${y - 50}, 898 ${y - 50}, 878 ${y - 17}`, {
      stroke: c.amber,
      strokeOpacity: 0.7,
      strokeDasharray: '3 5',
      markerEnd: 'url(#arrow)',
    }),
  );
  art.push(text(946, y - 44, 'restore', { fontSize: 11, fill: c.amber, textAnchor: 'middle' }));
  // @ mentions.
  let x = 712;
  for (const [label, color] of [
    ['@file', c.cyan],
    ['@folder', c.cyan],
    ['@web', c.green],
    ['@skill', c.violet],
    ['@mcp', c.amber],
  ]) {
    const p = pill(x, 150, label, { color });
    art.push(p);
    x += p.w + 8;
  }
  // AGENTS.md layers: global at the back, nested in front.
  [0, 1, 2].forEach((i) => {
    art.push(
      card(712 + i * 10, 196 - i * 8, 140, 28, {
        rx: 8,
        fill: '#0b1220',
        fillOpacity: 1,
        strokeOpacity: 0.12 + i * 0.06,
      }),
    );
  });
  art.push(mono(742, 202, 'AGENTS.md', { fontSize: 11, fill: c.text }));
  art.push(dot(806, 198, 3, c.amber));
  art.push(text(880, 196, 'global · project · nested', { fontSize: 11, fill: c.mute }));
  art.push(text(880, 212, 'rules, merged into the prompt', { fontSize: 11, fill: c.mute }));
  return art.join('');
}

/** Prompt layers stack into a mode that picks prompts, MCP servers and skills. */
function promptsModes() {
  const art = [];
  // Prompt layers, assembled top to bottom.
  const layers = [
    ['base prompt', c.amber],
    ['+ security', c.green],
    ['+ testing', c.green],
    ['+ Stripe conventions', c.violet],
    ['+ mode prompt', c.cyan],
  ];
  layers.forEach(([label, color], i) => {
    const y = 44 + i * 36;
    art.push(card(440, y, 190, 28, { rx: 8 }));
    art.push(`<rect x="440" y="${y}" width="4" height="28" rx="2" fill="${color}"/>`);
    art.push(mono(456, y + 18, label, { fontSize: 11, fill: color }));
  });
  art.push(path('M 640 132 C 660 132, 660 132, 684 132', { markerEnd: 'url(#arrow)' }));
  // Mode card.
  art.push(
    card(696, 44, 232, 172, {
      fill: c.amber,
      fillOpacity: 0.06,
      stroke: c.amber,
      strokeOpacity: 0.4,
    }),
  );
  art.push(text(714, 70, 'Payments review', { fontSize: 14, fill: '#f8fafc', fontWeight: 600 }));
  art.push(text(714, 88, 'custom mode', { fontSize: 11, fill: c.mute }));
  const rows = [
    [
      'prompts',
      [
        ['Stripe', c.violet],
        ['reviewer', c.violet],
      ],
    ],
    [
      'mcp',
      [
        ['github', c.cyan],
        ['sentry', c.cyan],
      ],
    ],
    ['skills', [['stripe-best-practices', c.green]]],
  ];
  rows.forEach(([label, chips], i) => {
    const y = 104 + i * 36;
    art.push(text(714, y + 16, label, { fontSize: 10, fill: c.mute, letterSpacing: 1 }));
    let x = 776;
    for (const [chip, color] of chips) {
      const p = pill(x, y, chip, { color, h: 22, size: 10, padX: 8 });
      art.push(p);
      x += p.w + 6;
    }
  });
  // Mode switcher, as in the composer.
  art.push(path('M 934 132 C 942 132, 942 132, 952 132', { markerEnd: 'url(#arrow)' }));
  ['Coding', 'Planning', 'Verification', 'Payments review'].forEach((name, i) => {
    const y = 58 + i * 38;
    const active = i === 3;
    art.push(
      pill(962, y, name, {
        color: active ? c.amber : c.mute,
        isMono: false,
        size: 12,
        w: 122,
        fill: active ? c.amber : '#ffffff',
      }),
    );
  });
  art.push(
    text(1023, 222, 'pick per session', { fontSize: 10, fill: c.mute, textAnchor: 'middle' }),
  );
  return art.join('');
}

/** A hub with spokes to every provider, direct or local. */
function providersModels() {
  const cx = 760;
  const cy = 132;
  const providers = [
    ['OpenRouter', '#818cf8'],
    ['Anthropic', '#d97757'],
    ['OpenAI', c.text],
    ['Gemini', '#60a5fa'],
    ['xAI', c.text],
    ['Mistral', '#fb923c'],
    ['DeepSeek', '#6d8bff'],
    ['Groq', '#f87171'],
    ['Ollama', c.text],
    ['LM Studio', c.violet],
    ['+ models.dev', c.cyan],
  ];
  const art = [];
  const nodes = providers.map(([label, color], i) => {
    const angle = -Math.PI / 2 + (i / providers.length) * Math.PI * 2;
    return { label, color, x: cx + Math.cos(angle) * 250, y: cy + Math.sin(angle) * 92 };
  });
  for (const node of nodes) {
    art.push(
      line(cx, cy, node.x, node.y, {
        stroke: node.color,
        strokeOpacity: 0.28,
        strokeDasharray: '2 6',
      }),
    );
  }
  for (const node of nodes) {
    const width = Math.round(measure(node.label, 12, false) + 30);
    art.push(pill(node.x - width / 2, node.y - 13, '', { color: node.color, w: width }));
    art.push(dot(node.x - width / 2 + 13, node.y, 3.5, node.color));
    art.push(
      text(node.x - width / 2 + 22, node.y + 4.5, node.label, {
        fontSize: 12,
        fill: node.color,
        fontWeight: 600,
      }),
    );
  }
  art.push(dot(cx, cy, 44, '#0b1220'));
  art.push(
    dot(cx, cy, 44, c.amber, {
      fillOpacity: 0.12,
      stroke: c.amber,
      strokeOpacity: 0.7,
      strokeWidth: 2,
    }),
  );
  art.push(dot(cx, cy, 58, 'none', { stroke: c.amber, strokeOpacity: 0.18 }));
  art.push(
    text(cx, cy - 2, 'your keys', {
      fontSize: 12,
      fill: '#fde68a',
      textAnchor: 'middle',
      fontWeight: 600,
    }),
  );
  art.push(text(cx, cy + 14, 'OS keychain', { fontSize: 10, fill: c.mute, textAnchor: 'middle' }));
  return art.join('');
}

/** Config sources feed discovery, which yields skills and MCP servers. */
function integrations() {
  const art = [];
  const sources = ['Claude', 'Cursor', 'VS Code', 'Codex', 'opencode', 'Gemini CLI', 'Windsurf'];
  const hub = { x: 760, y: 140 };
  let x = 440;
  const pills = sources.map((label) => {
    const p = pill(x, 36, label, { color: c.mute, isMono: false, size: 12 });
    const center = x + p.w / 2;
    x += p.w + 10;
    return { p, center };
  });
  const shift = (1080 - x + 10) / 2;
  for (const { p, center } of pills) {
    art.push(`<g transform="translate(${shift} 0)">${p}</g>`);
    art.push(
      path(`M ${center + shift} 64 C ${center + shift} 104, ${hub.x} 96, ${hub.x} ${hub.y - 26}`, {
        strokeOpacity: 0.3,
        strokeDasharray: '2 6',
      }),
    );
  }
  // Discovery hub.
  art.push(
    dot(hub.x, hub.y, 24, c.amber, {
      fillOpacity: 0.14,
      stroke: c.amber,
      strokeOpacity: 0.75,
      strokeWidth: 2,
    }),
  );
  art.push(dot(hub.x - 3, hub.y - 3, 8, 'none', { stroke: c.amber, strokeWidth: 2.5 }));
  art.push(
    line(hub.x + 3, hub.y + 3, hub.x + 9, hub.y + 9, {
      stroke: c.amber,
      strokeOpacity: 1,
      strokeWidth: 2.5,
    }),
  );
  // Skills.
  art.push(
    path(`M ${hub.x - 24} ${hub.y + 6} C ${hub.x - 90} ${hub.y + 12}, 640 170, 610 182`, {
      stroke: c.violet,
      strokeOpacity: 0.5,
      strokeDasharray: '2 6',
    }),
  );
  ['frontend-design', 'release-notes', 'stripe-best-practices'].forEach((skill, i) => {
    const y = 160 + i * 28 - 10;
    art.push(
      card(440 + i * 6, y, 170, 24, {
        rx: 8,
        fill: c.violet,
        fillOpacity: 0.08,
        stroke: c.violet,
        strokeOpacity: 0.3,
      }),
    );
    art.push(text(454 + i * 6, y + 16, `✦ ${skill}`, { fontSize: 11, fill: '#ddd6fe' }));
  });
  art.push(text(630, 244, 'skills', { fontSize: 11, fill: c.violet, fontWeight: 600 }));
  // MCP servers.
  art.push(
    path(`M ${hub.x + 24} ${hub.y + 6} C ${hub.x + 90} ${hub.y + 12}, 880 170, 910 182`, {
      stroke: c.cyan,
      strokeOpacity: 0.5,
      strokeDasharray: '2 6',
    }),
  );
  ['github', 'linear', 'sentry'].forEach((server, i) => {
    const y = 160 + i * 28 - 10;
    art.push(
      card(916, y, 150, 24, {
        rx: 8,
        fill: c.cyan,
        fillOpacity: 0.07,
        stroke: c.cyan,
        strokeOpacity: 0.3,
      }),
    );
    art.push(dot(930, y + 12, 3.5, c.green));
    art.push(mono(942, y + 16, server, { fontSize: 11, fill: '#a5f3fc' }));
    art.push(mono(1054, y + 16, 'mcp', { fontSize: 10, fill: c.mute, textAnchor: 'end' }));
  });
  art.push(
    text(876, 244, 'MCP servers', {
      fontSize: 11,
      fill: c.cyan,
      fontWeight: 600,
      textAnchor: 'end',
    }),
  );
  return art.join('');
}

/** Mini app windows fanned out in four themes, plus languages and sound. */
function lookAndFeel() {
  const themes = [
    { bg: '#0b1220', panel: '#111827', text: '#e5e7eb', accent: c.amber },
    { bg: '#191724', panel: '#1f1d2e', text: '#e0def4', accent: '#ebbcba' },
    { bg: '#eff1f5', panel: '#e6e9ef', text: '#4c4f69', accent: '#1e66f5' },
    { bg: '#f8fafc', panel: '#eef2f7', text: '#334155', accent: '#ea580c' },
  ];
  const art = [];
  themes.forEach((theme, i) => {
    const x = 430 + i * 60;
    const y = 36 + i * 16;
    const rotate = -8 + i * 4;
    const window = [
      `<rect x="${x}" y="${y}" width="250" height="150" rx="12" fill="${theme.bg}" stroke="#ffffff" stroke-opacity="0.16"/>`,
      `<rect x="${x}" y="${y}" width="250" height="22" rx="12" fill="${theme.panel}"/>`,
      `<rect x="${x}" y="${y + 12}" width="250" height="10" fill="${theme.panel}"/>`,
      [0, 1, 2]
        .map(
          (d) =>
            `<circle cx="${x + 14 + d * 12}" cy="${y + 11}" r="3.5" fill="${theme.text}" fill-opacity="0.35"/>`,
        )
        .join(''),
      `<rect x="${x + 8}" y="${y + 30}" width="62" height="112" rx="6" fill="${theme.panel}"/>`,
      `<rect x="${x + 14}" y="${y + 38}" width="50" height="10" rx="5" fill="${theme.accent}"/>`,
      bars(x + 14, y + 58, [44, 36, 40], { color: theme.text, opacity: 0.3, gap: 12 }),
      bars(x + 80, y + 36, [140, 110, 154, 90], { color: theme.text, opacity: 0.28, gap: 14 }),
      `<rect x="${x + 80}" y="${y + 98}" width="160" height="36" rx="8" fill="${theme.panel}"/>`,
      `<rect x="${x + 196}" y="${y + 108}" width="36" height="16" rx="8" fill="${theme.accent}"/>`,
    ].join('');
    art.push(`<g transform="rotate(${rotate} ${x + 125} ${y + 75})">${window}</g>`);
  });
  // Languages.
  let x = 920;
  let y = 56;
  for (const code of ['EN', 'DE', 'FR', 'ES', 'IT', 'PL', 'NL', 'SV', '+16']) {
    const p = pill(x, y, code, {
      color: code === '+16' ? c.amber : c.cyan,
      h: 24,
      size: 11,
      padX: 9,
    });
    art.push(p);
    x += p.w + 6;
    if (x > 1040) {
      x = 920;
      y += 32;
    }
  }
  // Sound wave.
  const wave = [6, 14, 24, 16, 30, 20, 10, 22, 12, 6];
  wave.forEach((height, i) => {
    art.push(
      `<rect x="${922 + i * 12}" y="${206 - height / 2}" width="5" height="${height}" rx="2.5" fill="url(#acc)" fill-opacity="0.7"/>`,
    );
  });
  return art.join('');
}

const banners = [
  {
    file: 'banner-agent-chat.svg',
    eyebrow: 'AGENT & CHAT',
    title: 'Watch it think,\nact and report back.',
    caption: 'Streaming · sub-agents · live cost',
    art: agentChat(),
  },
  {
    file: 'banner-tools-permissions.svg',
    eyebrow: 'TOOLS & PERMISSIONS',
    title: 'Safe commands run.\nRisky ones ask.',
    caption: 'A Rust tool loop, sandboxed to the project',
    art: toolsPermissions(),
  },
  {
    file: 'banner-diffs-history.svg',
    eyebrow: 'DIFFS & CONTEXT',
    title: 'Every prompt is a\nsnapshot you can undo.',
    caption: 'Shadow git · Monaco diffs · @ mentions',
    art: diffsHistory(),
  },
  {
    file: 'banner-prompts-modes.svg',
    eyebrow: 'PROMPTS & MODES',
    title: 'Shape what the\nagent sees.',
    caption: 'Your system prompts · custom modes',
    art: promptsModes(),
  },
  {
    file: 'banner-providers-models.svg',
    eyebrow: 'PROVIDERS & MODELS',
    title: 'Bring any model.\nKeep your keys.',
    caption: 'OpenRouter · direct APIs · local servers',
    art: providersModels(),
  },
  {
    file: 'banner-integrations.svg',
    eyebrow: 'INTEGRATIONS',
    title: 'Your skills and MCP\nservers, found for you.',
    caption: 'Read from the tools you already use',
    art: integrations(),
  },
  {
    file: 'banner-look-and-feel.svg',
    eyebrow: 'LOOK & FEEL',
    title: 'Make it yours.',
    caption: '14 themes · 24 languages · sounds',
    art: lookAndFeel(),
  },
];

mkdirSync(outDir, { recursive: true });
banners.forEach((banner, i) => {
  writeFileSync(resolve(outDir, banner.file), frame({ index: i + 1, ...banner }));
  console.log(`wrote docs/features/${banner.file}`);
});
