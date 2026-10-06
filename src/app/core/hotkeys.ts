import type { Settings } from './models';

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}

const KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
};

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'OS']);

export function normalizeKey(event: KeyboardEvent): string {
  if (KEY_LABELS[event.key]) {
    return KEY_LABELS[event.key];
  }
  if (event.key.length === 1) {
    return event.key.toUpperCase();
  }
  return event.key;
}

export interface HotkeyFormatOptions {
  /** Accept bare function keys (`F1`–`F24`) without a modifier. */
  functionKeys?: boolean;
  /** Accept any bare non-modifier key, e.g. `Delete` or `Backspace`. */
  anyKey?: boolean;
}

/**
 * Serializes a keyboard event into a canonical hotkey string such as
 * `Ctrl+Shift+K` or `Cmd+W`. Returns `null` for plain keys (no modifier) and
 * for modifier-only presses so that single letters cannot be captured. Bare
 * function keys are accepted when `functionKeys` is set, and any bare key when
 * `anyKey` is set.
 */
export function formatHotkey(
  event: KeyboardEvent,
  options: boolean | HotkeyFormatOptions = false,
): string | null {
  const { functionKeys, anyKey } =
    typeof options === 'boolean'
      ? { functionKeys: options, anyKey: false }
      : { functionKeys: options.functionKeys ?? false, anyKey: options.anyKey ?? false };
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }
  const modifiers: string[] = [];
  if (event.ctrlKey) {
    modifiers.push('Ctrl');
  }
  if (event.altKey) {
    modifiers.push('Alt');
  }
  if (event.shiftKey) {
    modifiers.push('Shift');
  }
  if (event.metaKey) {
    modifiers.push('Cmd');
  }
  const key = normalizeKey(event);
  if (modifiers.length === 0) {
    if (anyKey) {
      return key;
    }
    return functionKeys && isFunctionKey(key) ? key : null;
  }
  return [...modifiers, key].join('+');
}

export function isFunctionKey(key: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}

export function matchesHotkey(hotkey: string | null | undefined, event: KeyboardEvent): boolean {
  if (!hotkey) {
    return false;
  }
  const parts = splitHotkey(hotkey);
  if (parts.length === 0) {
    return false;
  }
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));
  return (
    normalizeKey(event) === key &&
    event.ctrlKey === modifiers.has('Ctrl') &&
    event.altKey === modifiers.has('Alt') &&
    event.shiftKey === modifiers.has('Shift') &&
    event.metaKey === modifiers.has('Cmd')
  );
}

export function displayHotkey(hotkey: string | null | undefined): string {
  if (!hotkey) {
    return '';
  }
  const mac = isMacPlatform();
  const arrows = { Up: '↑', Down: '↓', Left: '←', Right: '→' };
  const labels: Record<string, string> = mac
    ? { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘', ...arrows }
    : { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Cmd: 'Win', ...arrows };
  const parts = splitHotkey(hotkey).map((part) => labels[part] ?? part);
  return mac ? parts.join('') : parts.join('+');
}

/**
 * Splits `Cmd+Shift+K` into its parts. A trailing `++` means the `+` key
 * itself, so `Cmd++` is `['Cmd', '+']`.
 */
export function splitHotkey(hotkey: string): string[] {
  const trimmed = hotkey.trim();
  if (trimmed === '+') {
    return ['+'];
  }
  const plusKey = trimmed.endsWith('++');
  const parts = (plusKey ? trimmed.slice(0, -2) : trimmed)
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  return plusKey ? [...parts, '+'] : parts;
}

export function defaultOpenTabHotkey(): string {
  return isMacPlatform() ? 'Cmd+T' : 'Ctrl+T';
}

export function defaultCloseTabHotkey(): string {
  return isMacPlatform() ? 'Cmd+W' : 'Ctrl+W';
}

export function defaultNewSessionHotkey(): string {
  return isMacPlatform() ? 'Cmd+T' : 'Ctrl+T';
}

export function defaultDeleteSessionHotkey(): string {
  return isMacPlatform() ? 'Cmd+W' : 'Ctrl+W';
}

export function defaultTerminalHotkey(): string {
  return isMacPlatform() ? 'Cmd+J' : 'Ctrl+`';
}

/**
 * The same keys as for session tabs; a focused terminal takes them for its
 * own tabs. Off macOS that keeps `Ctrl+T` and `Ctrl+W` from the shell.
 */
export function defaultTerminalNewTabHotkey(): string {
  return isMacPlatform() ? 'Cmd+T' : 'Ctrl+T';
}

export function defaultTerminalCloseTabHotkey(): string {
  return isMacPlatform() ? 'Cmd+W' : 'Ctrl+W';
}

export function defaultWindowToggleHotkey(): string {
  return isMacPlatform() ? 'Cmd+Shift+Space' : 'Ctrl+Shift+Space';
}

/** Settings fields that each hold one configurable hotkey. */
export type HotkeyField =
  | 'openTabHotkey'
  | 'closeTabHotkey'
  | 'newSessionHotkey'
  | 'deleteSessionHotkey'
  | 'terminalHotkey'
  | 'windowToggleHotkey';

/** Hotkeys whose overrides live in `Settings.hotkeys`, keyed by this id. */
export type HotkeyAction =
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'terminalNewTab'
  | 'terminalCloseTab'
  | 'focusNextPanel'
  | 'focusPreviousPanel'
  | 'nextPanelTab'
  | 'previousPanelTab'
  | 'chatSend'
  | 'chatNewLine'
  | 'chatStop'
  | 'chatRecallPrompt'
  | 'chatToggleMode'
  | 'gitToggleStage'
  | 'gitDiscardFiles'
  | 'gitSelectAllFiles'
  | 'diffFind'
  | 'diffSelectAll'
  | 'diffCopy'
  | 'diffNextHunk'
  | 'diffPreviousHunk'
  | 'diffStage'
  | 'diffUnstage'
  | 'diffDiscard'
  | 'branchNewBranch'
  | 'branchNewTag'
  | 'branchCopyName'
  | 'editorSave'
  | 'annotatorUndo';

export type HotkeyCategory = 'general' | 'sessions' | 'chat' | 'git' | 'editor' | 'permissions';

export const HOTKEY_CATEGORIES: readonly HotkeyCategory[] = [
  'general',
  'sessions',
  'chat',
  'git',
  'editor',
  'permissions',
];

/**
 * Which keys may be recorded without a modifier: function keys, special keys
 * such as Enter or arrows (never letters or Space), any key, or an allowlist.
 */
export type BareKeys = 'function' | 'special' | 'any' | readonly string[];

interface HotkeyDefinitionBase {
  category: HotkeyCategory;
  /** Transloco key of the label. */
  label: string;
  /** Transloco key of an optional explanation. */
  hint?: string;
}

export type HotkeyDefinition =
  | (HotkeyDefinitionBase & {
      kind: 'field';
      id: HotkeyField;
      defaults: () => string[];
      bare?: BareKeys;
    })
  | (HotkeyDefinitionBase & {
      kind: 'action';
      id: HotkeyAction;
      defaults: () => string[];
      bare?: BareKeys;
    })
  | (HotkeyDefinitionBase & {
      /** Built-in keys that are listed for reference but cannot be changed. */
      kind: 'fixed';
      id: string;
      keys: string[];
    });

export type ConfigurableHotkey = Exclude<HotkeyDefinition, { kind: 'fixed' }>;

function mod(key: string): string {
  return `${isMacPlatform() ? 'Cmd' : 'Ctrl'}+${key}`;
}

const DELETE_KEYS = ['Delete', 'Backspace'] as const;

export const HOTKEY_DEFINITIONS: readonly HotkeyDefinition[] = [
  // General
  {
    kind: 'field',
    id: 'newSessionHotkey',
    category: 'general',
    label: 'settings.hotkeys.newSession',
    hint: 'settings.hotkeys.newSessionHint',
    defaults: () => [defaultNewSessionHotkey()],
  },
  {
    kind: 'field',
    id: 'openTabHotkey',
    category: 'general',
    label: 'settings.hotkeys.openTab',
    hint: 'settings.hotkeys.openTabHint',
    defaults: () => [defaultOpenTabHotkey()],
  },
  {
    kind: 'field',
    id: 'closeTabHotkey',
    category: 'general',
    label: 'settings.hotkeys.closeTab',
    hint: 'settings.hotkeys.closeTabHint',
    defaults: () => [defaultCloseTabHotkey()],
  },
  {
    kind: 'field',
    id: 'terminalHotkey',
    category: 'general',
    label: 'settings.hotkeys.terminal',
    hint: 'settings.hotkeys.terminalHint',
    defaults: () => [defaultTerminalHotkey()],
  },
  // Only while the terminal has keyboard focus; elsewhere the same keys open
  // and close session tabs.
  {
    kind: 'action',
    id: 'terminalNewTab',
    category: 'general',
    label: 'settings.hotkeys.terminalNewTab',
    hint: 'settings.hotkeys.terminalNewTabHint',
    defaults: () => [defaultTerminalNewTabHotkey()],
  },
  {
    kind: 'action',
    id: 'terminalCloseTab',
    category: 'general',
    label: 'settings.hotkeys.terminalCloseTab',
    hint: 'settings.hotkeys.terminalCloseTabHint',
    defaults: () => [defaultTerminalCloseTabHotkey()],
  },
  // Handled by the terminal itself (see TerminalView). On macOS Cmd+C/V are
  // the webview's own copy and paste; elsewhere Ctrl+C/V belong to the shell.
  {
    kind: 'fixed',
    id: 'terminalCopy',
    category: 'general',
    label: 'settings.hotkeys.terminalCopy',
    keys: [isMacPlatform() ? 'Cmd+C' : 'Ctrl+Shift+C'],
  },
  {
    kind: 'fixed',
    id: 'terminalPaste',
    category: 'general',
    label: 'settings.hotkeys.terminalPaste',
    keys: [isMacPlatform() ? 'Cmd+V' : 'Ctrl+Shift+V'],
  },
  ...(isMacPlatform()
    ? [
        {
          kind: 'fixed',
          id: 'terminalClear',
          category: 'general',
          label: 'settings.hotkeys.terminalClear',
          keys: ['Cmd+K'],
        } satisfies HotkeyDefinition,
      ]
    : []),
  {
    kind: 'action',
    id: 'focusNextPanel',
    category: 'general',
    label: 'settings.hotkeys.focusNextPanel',
    defaults: () => ['Tab'],
    bare: 'special',
  },
  {
    kind: 'action',
    id: 'focusPreviousPanel',
    category: 'general',
    label: 'settings.hotkeys.focusPreviousPanel',
    defaults: () => ['Shift+Tab'],
    bare: 'special',
  },
  {
    kind: 'action',
    id: 'nextPanelTab',
    category: 'general',
    label: 'settings.hotkeys.nextPanelTab',
    defaults: () => ['Ctrl+Tab'],
  },
  {
    kind: 'action',
    id: 'previousPanelTab',
    category: 'general',
    label: 'settings.hotkeys.previousPanelTab',
    defaults: () => ['Ctrl+Shift+Tab'],
  },
  {
    kind: 'action',
    id: 'zoomIn',
    category: 'general',
    label: 'settings.hotkeys.zoomIn',
    // `=` and `+` share a key on US layouts; `+` has its own on German ones.
    defaults: () => [mod('='), mod('+'), mod('Shift++'), mod('Shift+=')],
  },
  {
    kind: 'action',
    id: 'zoomOut',
    category: 'general',
    label: 'settings.hotkeys.zoomOut',
    defaults: () => [mod('-'), mod('Shift+_')],
  },
  {
    kind: 'action',
    id: 'zoomReset',
    category: 'general',
    label: 'settings.hotkeys.zoomReset',
    defaults: () => [mod('0')],
  },
  {
    kind: 'field',
    id: 'windowToggleHotkey',
    category: 'general',
    label: 'settings.hotkeys.windowToggle',
    hint: 'settings.hotkeys.windowToggleHint',
    defaults: () => [defaultWindowToggleHotkey()],
    bare: 'function',
  },
  {
    kind: 'fixed',
    id: 'closeOverlay',
    category: 'general',
    label: 'settings.hotkeys.closeOverlay',
    keys: ['Esc'],
  },
  // Sessions
  {
    kind: 'field',
    id: 'deleteSessionHotkey',
    category: 'sessions',
    label: 'settings.hotkeys.deleteSession',
    hint: 'settings.hotkeys.deleteSessionHint',
    defaults: () => [defaultDeleteSessionHotkey()],
    bare: DELETE_KEYS,
  },
  {
    kind: 'fixed',
    id: 'sessionNavigate',
    category: 'sessions',
    label: 'settings.hotkeys.sessionNavigate',
    keys: ['Up', 'Down'],
  },
  {
    kind: 'fixed',
    id: 'sessionOpen',
    category: 'sessions',
    label: 'settings.hotkeys.sessionOpen',
    keys: ['Enter'],
  },
  // Chat
  {
    kind: 'action',
    id: 'chatSend',
    category: 'chat',
    label: 'settings.hotkeys.chatSend',
    defaults: () => ['Enter'],
    bare: 'special',
  },
  {
    kind: 'action',
    id: 'chatNewLine',
    category: 'chat',
    label: 'settings.hotkeys.chatNewLine',
    defaults: () => ['Shift+Enter'],
    bare: 'special',
  },
  {
    kind: 'action',
    id: 'chatStop',
    category: 'chat',
    label: 'settings.hotkeys.chatStop',
    defaults: () => ['Esc'],
    bare: 'special',
  },
  {
    kind: 'action',
    id: 'chatRecallPrompt',
    category: 'chat',
    label: 'settings.hotkeys.chatRecallPrompt',
    defaults: () => ['Up'],
    bare: 'special',
  },
  {
    kind: 'action',
    id: 'chatToggleMode',
    category: 'chat',
    label: 'settings.hotkeys.chatToggleMode',
    hint: 'settings.hotkeys.chatToggleModeHint',
    // Not `M`: macOS gives Cmd+Shift+M to the Minimize item of the window
    // menu (Cmd+M) before the webview sees the key.
    defaults: () => [mod('Shift+P')],
  },
  // Git
  {
    kind: 'action',
    id: 'gitToggleStage',
    category: 'git',
    label: 'settings.hotkeys.gitToggleStage',
    defaults: () => ['Enter', 'Space'],
    bare: 'any',
  },
  {
    kind: 'action',
    id: 'gitDiscardFiles',
    category: 'git',
    label: 'settings.hotkeys.gitDiscardFiles',
    defaults: () => [...DELETE_KEYS],
    bare: 'any',
  },
  {
    kind: 'action',
    id: 'gitSelectAllFiles',
    category: 'git',
    label: 'settings.hotkeys.gitSelectAllFiles',
    defaults: () => [mod('A')],
  },
  {
    kind: 'action',
    id: 'diffStage',
    category: 'git',
    label: 'settings.hotkeys.diffStage',
    defaults: () => ['S'],
    bare: 'any',
  },
  {
    kind: 'action',
    id: 'diffUnstage',
    category: 'git',
    label: 'settings.hotkeys.diffUnstage',
    defaults: () => ['U'],
    bare: 'any',
  },
  {
    kind: 'action',
    id: 'diffDiscard',
    category: 'git',
    label: 'settings.hotkeys.diffDiscard',
    defaults: () => [...DELETE_KEYS],
    bare: 'any',
  },
  {
    kind: 'action',
    id: 'diffNextHunk',
    category: 'git',
    label: 'settings.hotkeys.diffNextHunk',
    defaults: () => ['J'],
    bare: 'any',
  },
  {
    kind: 'action',
    id: 'diffPreviousHunk',
    category: 'git',
    label: 'settings.hotkeys.diffPreviousHunk',
    defaults: () => ['K'],
    bare: 'any',
  },
  {
    kind: 'action',
    id: 'diffSelectAll',
    category: 'git',
    label: 'settings.hotkeys.diffSelectAll',
    defaults: () => [mod('A')],
  },
  {
    kind: 'action',
    id: 'diffCopy',
    category: 'git',
    label: 'settings.hotkeys.diffCopy',
    defaults: () => [mod('C')],
  },
  {
    kind: 'action',
    id: 'diffFind',
    category: 'git',
    label: 'settings.hotkeys.diffFind',
    defaults: () => [mod('F')],
  },
  {
    kind: 'action',
    id: 'branchNewBranch',
    category: 'git',
    label: 'settings.hotkeys.branchNewBranch',
    defaults: () => [mod('B')],
  },
  {
    kind: 'action',
    id: 'branchNewTag',
    category: 'git',
    label: 'settings.hotkeys.branchNewTag',
    defaults: () => [mod('G')],
  },
  {
    kind: 'action',
    id: 'branchCopyName',
    category: 'git',
    label: 'settings.hotkeys.branchCopyName',
    defaults: () => [mod('C')],
  },
  {
    kind: 'fixed',
    id: 'gitMoveSelection',
    category: 'git',
    label: 'settings.hotkeys.gitMoveSelection',
    keys: ['Up', 'Down'],
  },
  {
    kind: 'fixed',
    id: 'gitExtendSelection',
    category: 'git',
    label: 'settings.hotkeys.gitExtendSelection',
    keys: ['Shift+Up', 'Shift+Down'],
  },
  // Editor
  {
    kind: 'action',
    id: 'editorSave',
    category: 'editor',
    label: 'settings.hotkeys.editorSave',
    defaults: () => [mod('S')],
  },
  {
    kind: 'action',
    id: 'annotatorUndo',
    category: 'editor',
    label: 'settings.hotkeys.annotatorUndo',
    defaults: () => [mod('Z')],
  },
  // Permission prompts
  {
    kind: 'fixed',
    id: 'permissionChoose',
    category: 'permissions',
    label: 'settings.hotkeys.permissionChoose',
    keys: ['1–9'],
  },
  {
    kind: 'fixed',
    id: 'permissionMove',
    category: 'permissions',
    label: 'settings.hotkeys.permissionMove',
    keys: ['Up', 'Down', 'Left', 'Right'],
  },
  {
    kind: 'fixed',
    id: 'permissionConfirm',
    category: 'permissions',
    label: 'settings.hotkeys.permissionConfirm',
    keys: ['Enter'],
  },
  {
    kind: 'fixed',
    id: 'permissionDeny',
    category: 'permissions',
    label: 'settings.hotkeys.permissionDeny',
    keys: ['Esc'],
  },
];

/** The effective key combinations for a configurable hotkey. */
export function hotkeyBindings(
  settings: Settings | null | undefined,
  id: HotkeyField | HotkeyAction,
): string[] {
  const definition = HOTKEY_DEFINITIONS.find((entry) => entry.id === id) as
    | ConfigurableHotkey
    | undefined;
  if (!definition) {
    return [];
  }
  if (definition.kind === 'field') {
    const value = settings?.[definition.id];
    return value ? [value] : definition.defaults();
  }
  const override = settings?.hotkeys?.[definition.id];
  return override ? [override] : definition.defaults();
}

/** Whether `event` triggers the given hotkey under the current settings. */
export function matchesAction(
  settings: Settings | null | undefined,
  id: HotkeyField | HotkeyAction,
  event: KeyboardEvent,
): boolean {
  return hotkeyBindings(settings, id).some((hotkey) => matchesHotkey(hotkey, event));
}

/** Displays alternative bindings, e.g. `⌘= / ⌘+`. */
export function displayBindings(bindings: readonly string[]): string {
  return bindings.map(displayHotkey).join(' / ');
}

/** Whether a recorded key without modifiers is allowed for this hotkey. */
export function acceptsBareKey(bare: BareKeys | undefined, key: string): boolean {
  if (!bare) {
    return false;
  }
  if (bare === 'any') {
    return true;
  }
  if (bare === 'function') {
    return isFunctionKey(key);
  }
  if (bare === 'special') {
    return key.length > 1 && key !== 'Space';
  }
  return bare.includes(key);
}
