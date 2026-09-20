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
  if (event.key.length === 1) {
    return event.key.toUpperCase();
  }
  return KEY_LABELS[event.key] ?? event.key;
}

/**
 * Serializes a keyboard event into a canonical hotkey string such as
 * `Ctrl+Shift+K` or `Cmd+W`. Returns `null` for plain keys (no modifier) and
 * for modifier-only presses so that single letters cannot be captured.
 */
export function formatHotkey(event: KeyboardEvent): string | null {
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
  if (modifiers.length === 0) {
    return null;
  }
  return [...modifiers, normalizeKey(event)].join('+');
}

export function matchesHotkey(hotkey: string | null | undefined, event: KeyboardEvent): boolean {
  if (!hotkey) {
    return false;
  }
  const parts = hotkey
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
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
  const labels: Record<string, string> = mac
    ? { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' }
    : { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Cmd: 'Win' };
  const parts = hotkey.split('+').map((part) => labels[part] ?? part);
  return mac ? parts.join('') : parts.join('+');
}

export function defaultOpenTabHotkey(): string {
  return isMacPlatform() ? 'Cmd+T' : 'Ctrl+T';
}

export function defaultCloseTabHotkey(): string {
  return isMacPlatform() ? 'Cmd+W' : 'Ctrl+W';
}
