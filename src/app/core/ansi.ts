const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const ANSI_COLORS = [
  '#000000',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
];

const ANSI_BRIGHT = [
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#ffffff',
];

interface AnsiState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
  fg: string | null;
  bg: string | null;
}

function initialState(): AnsiState {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
    fg: null,
    bg: null,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function palette256(index: number): string | null {
  if (!Number.isFinite(index) || index < 0 || index > 255) {
    return null;
  }
  if (index < 8) {
    return ANSI_COLORS[index];
  }
  if (index < 16) {
    return ANSI_BRIGHT[index - 8];
  }
  if (index < 232) {
    const value = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(value / 36)];
    const g = steps[Math.floor((value % 36) / 6)];
    const b = steps[value % 6];
    return `rgb(${r},${g},${b})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function applySgr(state: AnsiState, params: string): void {
  const codes = (params.length === 0 ? '0' : params)
    .split(';')
    .map((part) => (part === '' ? 0 : Number(part)));

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) {
      Object.assign(state, initialState());
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 2) {
      state.dim = true;
    } else if (code === 3) {
      state.italic = true;
    } else if (code === 4) {
      state.underline = true;
    } else if (code === 7) {
      state.inverse = true;
    } else if (code === 9) {
      state.strike = true;
    } else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) {
      state.italic = false;
    } else if (code === 24) {
      state.underline = false;
    } else if (code === 27) {
      state.inverse = false;
    } else if (code === 29) {
      state.strike = false;
    } else if (code >= 30 && code <= 37) {
      state.fg = ANSI_COLORS[code - 30];
    } else if (code >= 90 && code <= 97) {
      state.fg = ANSI_BRIGHT[code - 90];
    } else if (code === 39) {
      state.fg = null;
    } else if (code >= 40 && code <= 47) {
      state.bg = ANSI_COLORS[code - 40];
    } else if (code >= 100 && code <= 107) {
      state.bg = ANSI_BRIGHT[code - 100];
    } else if (code === 49) {
      state.bg = null;
    } else if (code === 38 || code === 48) {
      const target = code === 38 ? 'fg' : 'bg';
      const mode = codes[index + 1];
      if (mode === 5) {
        const color = palette256(codes[index + 2]);
        if (color) {
          state[target] = color;
        }
        index += 2;
      } else if (mode === 2) {
        const [r, g, b] = [codes[index + 2], codes[index + 3], codes[index + 4]];
        if ([r, g, b].every((value) => Number.isFinite(value))) {
          state[target] = `rgb(${r},${g},${b})`;
        }
        index += 4;
      }
    }
  }
}

function styleOf(state: AnsiState): string {
  const styles: string[] = [];
  if (state.bold) {
    styles.push('font-weight:600');
  }
  if (state.dim) {
    styles.push('opacity:.6');
  }
  if (state.italic) {
    styles.push('font-style:italic');
  }
  const decorations = [
    state.underline ? 'underline' : '',
    state.strike ? 'line-through' : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (decorations) {
    styles.push(`text-decoration:${decorations}`);
  }
  const fg = state.inverse ? state.bg : state.fg;
  const bg = state.inverse ? state.fg : state.bg;
  if (fg) {
    styles.push(`color:${fg}`);
  }
  if (bg) {
    styles.push(`background-color:${bg}`);
  }
  return styles.join(';');
}

export function ansiToHtml(input: string): string {
  const state = initialState();
  let result = '';
  let index = 0;
  let spanOpen = false;

  const closeSpan = () => {
    if (spanOpen) {
      result += '</span>';
      spanOpen = false;
    }
  };

  const openSpan = () => {
    closeSpan();
    const styles = styleOf(state);
    if (styles) {
      result += `<span style="${styles}">`;
      spanOpen = true;
    }
  };

  while (index < input.length) {
    const escape = input.indexOf(ESC, index);
    if (escape === -1) {
      result += escapeHtml(input.slice(index));
      break;
    }
    result += escapeHtml(input.slice(index, escape));

    const marker = input[escape + 1];
    if (marker === '[') {
      const match = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(input.slice(escape));
      if (match) {
        if (match[2] === 'm') {
          applySgr(state, match[1]);
          openSpan();
        }
        index = escape + match[0].length;
        continue;
      }
    }
    if (marker === ']') {
      const bel = input.indexOf(BEL, escape);
      const terminator = input.indexOf(`${ESC}\\`, escape);
      if (bel !== -1 && (terminator === -1 || bel < terminator)) {
        index = bel + 1;
        continue;
      }
      if (terminator !== -1) {
        index = terminator + 2;
        continue;
      }
    }
    index = escape + 1;
  }

  closeSpan();
  return result;
}