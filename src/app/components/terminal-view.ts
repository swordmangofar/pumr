import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { TranslocoService } from '@jsverse/transloco';
import type { FitAddon } from '@xterm/addon-fit';
import type { ITheme, Terminal } from '@xterm/xterm';
import { api } from '../core/api';
import { isMacPlatform, matchesAction, matchesHotkey } from '../core/hotkeys';
import { TerminalEvent } from '../core/models';
import { SettingsService } from '../core/settings.service';
import { TerminalService, TerminalTab } from '../core/terminal.service';
import { ThemeService } from '../core/theme.service';
import { ThemePreset } from '../core/themes';

/** The bundled icon font of `styles.css`, for the glyphs prompt themes use. */
const SYMBOLS_FONT = '"Symbols Nerd Font"';
const FONT_SIZE = 13;
const FONT_FAMILY = `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", ${SYMBOLS_FONT}, monospace`;

/**
 * Loads the icon font before a terminal draws with it. The browser fetches it
 * only once a glyph needs it, and xterm keeps the width it measured for a
 * glyph, so an icon drawn before that would keep the width of a missing one.
 */
function loadSymbolsFont(): Promise<unknown> {
  return document.fonts.load(`${FONT_SIZE}px ${SYMBOLS_FONT}`, '\ue0b0').catch(() => undefined);
}

/** How long a shell's output has to pause before it counts as its prompt. */
const PROMPT_PAUSE_MS = 300;
/** How long a shell that prints nothing gets before commands are sent anyway. */
const SILENT_SHELL_MS = 2000;

/** ANSI colours readable on dark and on light backgrounds. */
const DARK_ANSI: ITheme = {
  black: '#1e1e1e',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#e879f9',
  cyan: '#22d3ee',
  white: '#e5e5e5',
  brightBlack: '#737373',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#f0abfc',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
};

const LIGHT_ANSI: ITheme = {
  black: '#262626',
  red: '#b91c1c',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#1d4ed8',
  magenta: '#a21caf',
  cyan: '#0e7490',
  white: '#a3a3a3',
  brightBlack: '#525252',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue: '#2563eb',
  brightMagenta: '#c026d3',
  brightCyan: '#0891b2',
  brightWhite: '#171717',
};

/** `color` at `alpha` opacity, for six-digit hex theme colours. */
function withAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    return color;
  }
  const hex = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0');
  return `${color}${hex}`;
}

export function terminalTheme(theme: ThemePreset): ITheme {
  return {
    ...(theme.scheme === 'dark' ? DARK_ANSI : LIGHT_ANSI),
    // Transparent, so the dock's glass panel shows through.
    background: '#00000000',
    foreground: theme.mist,
    cursor: theme.accent,
    cursorAccent: theme.ink,
    selectionBackground: withAlpha(theme.accent, 0.35),
  };
}

/**
 * One interactive shell: an xterm.js terminal wired to a backend
 * pseudo-terminal. The shell starts when the view first renders and ends when
 * the view is destroyed, i.e. when its tab is closed.
 */
@Component({
  selector: 'app-terminal-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block h-full w-full' },
  template: `<div #host class="h-full w-full"></div>`,
})
export class TerminalView {
  readonly tab = input.required<TerminalTab>();
  /** Whether this terminal is the one shown in the dock. */
  readonly visible = input(false);

  private readonly terminals = inject(TerminalService);
  private readonly settings = inject(SettingsService);
  private readonly theme = inject(ThemeService);
  private readonly transloco = inject(TranslocoService);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  private terminal: Terminal | null = null;
  private fit: FitAddon | null = null;
  private terminalId: string | null = null;
  /** Input typed before the shell was ready. */
  private pendingInput = '';
  /** Whether the shell has shown its first prompt. */
  private atPrompt = false;
  /** Commands from the chat that wait for that prompt. */
  private waitingCommands: string[] = [];
  private promptTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private resizeObserver?: ResizeObserver;
  private fitFrame = 0;

  constructor() {
    afterNextRender(() => void this.start());

    effect(() => {
      const theme = terminalTheme(this.theme.current());
      if (this.terminal) {
        this.terminal.options.theme = theme;
      }
    });

    effect(() => {
      this.terminals.focusRequest();
      if (this.visible() && this.terminals.open()) {
        // Wait for the dock to be laid out before fitting and focusing.
        requestAnimationFrame(() => {
          this.scheduleFit();
          this.terminal?.focus();
        });
      }
    });

    effect(() => {
      this.terminals.runRequest();
      untracked(() => {
        for (const command of this.terminals.takeCommands(this.tab().key)) {
          this.run(command);
        }
      });
    });

    inject(DestroyRef).onDestroy(() => this.dispose());
  }

  private async start(): Promise<void> {
    const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
      loadSymbolsFont(),
    ]);
    await this.terminals.ready;
    if (this.destroyed) {
      return;
    }

    const terminal = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: terminalTheme(this.theme.current()),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        void api.openExternalUrl(uri);
      }),
    );
    terminal.attachCustomKeyEventHandler((event) => this.handleKey(event));
    terminal.onData((data) => this.send(data));
    terminal.onResize(({ cols, rows }) => {
      if (this.terminalId) {
        void api.terminalResize(this.terminalId, cols, rows).catch(() => undefined);
      }
    });
    terminal.onTitleChange((title) => this.terminals.setTitle(this.tab().key, title));

    const host = this.element.nativeElement.querySelector('div') as HTMLDivElement;
    terminal.open(host);
    this.terminal = terminal;
    this.fit = fit;
    this.fitNow();
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(host);
    if (this.visible() && this.terminals.open()) {
      terminal.focus();
    }

    const channel = new Channel<TerminalEvent>();
    channel.onmessage = (event) => this.onEvent(event);
    try {
      const id = await api.terminalOpen(
        this.tab().projectId,
        terminal.cols,
        terminal.rows,
        channel,
      );
      if (this.destroyed) {
        void api.terminalClose(id);
        return;
      }
      this.terminalId = id;
      this.terminals.started(this.tab().key, id);
      if (this.pendingInput) {
        this.send(this.pendingInput);
        this.pendingInput = '';
      }
      if (!this.atPrompt && !this.promptTimer) {
        this.expectPrompt(SILENT_SHELL_MS);
      }
    } catch (error) {
      const message = this.transloco.translate('terminal.failed', { error: String(error) });
      terminal.write(`\x1b[31m${message}\x1b[0m\r\n`);
    }
  }

  private onEvent(event: TerminalEvent): void {
    if (event.kind === 'output') {
      this.terminal?.write(event.data, () => this.shellPrinted());
      return;
    }
    this.terminalId = null;
    this.waitingCommands = [];
    if (event.code !== 0 && this.terminal) {
      const message = this.transloco.translate('terminal.exited', { code: event.code ?? '?' });
      this.terminal.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
    }
    this.terminals.exited(this.tab().key, event.code);
  }

  /**
   * Runs a command sent from the chat, once the shell waits at its prompt. It
   * is pasted, so a shell with bracketed paste takes several lines as one
   * command instead of running them as they arrive.
   */
  private run(command: string): void {
    if (!this.atPrompt || !this.terminal) {
      this.waitingCommands.push(command);
      return;
    }
    this.terminal.paste(command);
    this.send('\r');
  }

  /**
   * Looks for the shell's first prompt after it printed something. zsh, fish
   * and bash 5 turn on bracketed paste when they show it; for other shells a
   * pause in the output stands in for that. Sent earlier, a command would be
   * echoed twice or answer a question the shell's profile asks.
   */
  private shellPrinted(): void {
    if (this.atPrompt || this.destroyed) {
      return;
    }
    if (this.terminal?.modes.bracketedPasteMode) {
      this.reachedPrompt();
    } else {
      this.expectPrompt(PROMPT_PAUSE_MS);
    }
  }

  private expectPrompt(delay: number): void {
    if (this.promptTimer) {
      clearTimeout(this.promptTimer);
    }
    this.promptTimer = setTimeout(() => this.reachedPrompt(), delay);
  }

  private reachedPrompt(): void {
    if (this.promptTimer) {
      clearTimeout(this.promptTimer);
      this.promptTimer = null;
    }
    this.atPrompt = true;
    const commands = this.waitingCommands;
    this.waitingCommands = [];
    for (const command of commands) {
      this.run(command);
    }
  }

  private send(data: string): void {
    if (!this.terminalId) {
      if (this.tab().exitCode === null) {
        this.pendingInput += data;
      }
      return;
    }
    void api.terminalWrite(this.terminalId, data).catch(() => undefined);
  }

  /**
   * Decides which keys the shell gets. Returning `false` leaves the key to
   * the app: the terminal and terminal tab hotkeys, and on macOS every `Cmd`
   * shortcut (copy, paste, zoom, tabs) except `Cmd+K`, which clears the
   * terminal. Elsewhere `Ctrl+Shift+C`/`V` copy and paste, as in other
   * terminals, since plain `Ctrl+C`/`V` belong to the shell.
   */
  private handleKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') {
      return true;
    }
    const settings = this.settings.settings();
    if (
      matchesHotkey(settings?.terminalHotkey, event) ||
      matchesAction(settings, 'terminalNewTab', event) ||
      matchesAction(settings, 'terminalCloseTab', event)
    ) {
      return false;
    }
    if (isMacPlatform()) {
      if (event.metaKey && event.key === 'k' && !event.shiftKey && !event.altKey) {
        // Cmd+K clears the scrollback, as in Terminal.app and iTerm.
        this.terminal?.clear();
        event.preventDefault();
        return false;
      }
      return !event.metaKey;
    }
    if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === 'c') {
        const selection = this.terminal?.getSelection();
        if (selection) {
          void navigator.clipboard?.writeText(selection).catch(() => undefined);
        }
        event.preventDefault();
        return false;
      }
      if (key === 'v') {
        // Leave it to the webview, which pastes into xterm's input.
        return false;
      }
    }
    return true;
  }

  private scheduleFit(): void {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => this.fitNow());
  }

  private fitNow(): void {
    const host = this.element.nativeElement;
    // A hidden terminal has no size; fitting it would shrink the shell to 1x1.
    if (!this.fit || host.clientWidth === 0 || host.clientHeight === 0) {
      return;
    }
    try {
      this.fit.fit();
    } catch {
      // The renderer may not be measured yet; the next resize fits it.
    }
  }

  private dispose(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.fitFrame);
    this.resizeObserver?.disconnect();
    if (this.promptTimer) {
      clearTimeout(this.promptTimer);
    }
    if (this.terminalId) {
      void api.terminalClose(this.terminalId).catch(() => undefined);
      this.terminalId = null;
    }
    this.terminal?.dispose();
    this.terminal = null;
  }
}
