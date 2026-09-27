import { describe, expect, it } from 'vitest';
import {
  acceptsBareKey,
  formatHotkey,
  HOTKEY_DEFINITIONS,
  hotkeyBindings,
  matchesAction,
  matchesHotkey,
  splitHotkey,
} from './hotkeys';
import { Settings } from './models';

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, ...init });
}

describe('formatHotkey', () => {
  it('rejects a bare letter by default', () => {
    expect(formatHotkey(keydown({ key: 'a' }))).toBeNull();
  });

  it('accepts bare Delete and Backspace when anyKey is enabled', () => {
    expect(formatHotkey(keydown({ key: 'Backspace' }), { anyKey: true })).toBe('Backspace');
    expect(formatHotkey(keydown({ key: 'Delete' }), { anyKey: true })).toBe('Delete');
  });

  it('serializes modifier combinations', () => {
    expect(formatHotkey(keydown({ key: 'n', ctrlKey: true }))).toBe('Ctrl+N');
    expect(formatHotkey(keydown({ key: 'n', metaKey: true }))).toBe('Cmd+N');
  });
});

describe('matchesHotkey', () => {
  it('matches modifier combinations', () => {
    expect(matchesHotkey('Ctrl+N', keydown({ key: 'n', ctrlKey: true }))).toBe(true);
    expect(matchesHotkey('Ctrl+N', keydown({ key: 'n' }))).toBe(false);
  });

  it('matches bare action keys', () => {
    expect(matchesHotkey('Backspace', keydown({ key: 'Backspace' }))).toBe(true);
    expect(matchesHotkey('Delete', keydown({ key: 'Delete' }))).toBe(true);
    expect(matchesHotkey('Backspace', keydown({ key: 'Delete' }))).toBe(false);
  });
});

describe('splitHotkey', () => {
  it('treats a trailing ++ as the plus key', () => {
    expect(splitHotkey('Cmd++')).toEqual(['Cmd', '+']);
    expect(splitHotkey('Ctrl+Shift++')).toEqual(['Ctrl', 'Shift', '+']);
    expect(splitHotkey('+')).toEqual(['+']);
    expect(splitHotkey('Ctrl+Shift+K')).toEqual(['Ctrl', 'Shift', 'K']);
  });

  it('lets matchesHotkey match the plus key', () => {
    expect(matchesHotkey('Cmd++', keydown({ key: '+', metaKey: true }))).toBe(true);
    expect(matchesHotkey('Cmd++', keydown({ key: '+', metaKey: true, shiftKey: true }))).toBe(
      false,
    );
  });
});

describe('matchesAction', () => {
  const settings = (hotkeys: Record<string, string>) => ({ hotkeys }) as Settings;

  it('uses the defaults without an override', () => {
    expect(hotkeyBindings(settings({}), 'chatSend')).toEqual(['Enter']);
    expect(matchesAction(settings({}), 'chatSend', keydown({ key: 'Enter' }))).toBe(true);
    expect(matchesAction(null, 'diffNextHunk', keydown({ key: 'j' }))).toBe(true);
  });

  it('replaces all defaults with an override', () => {
    const custom = settings({ chatSend: 'Ctrl+Enter' });
    expect(matchesAction(custom, 'chatSend', keydown({ key: 'Enter' }))).toBe(false);
    expect(matchesAction(custom, 'chatSend', keydown({ key: 'Enter', ctrlKey: true }))).toBe(
      true,
    );
  });

  it('reads single-hotkey settings fields', () => {
    const custom = { deleteSessionHotkey: 'Delete' } as Settings;
    expect(matchesAction(custom, 'deleteSessionHotkey', keydown({ key: 'Delete' }))).toBe(true);
  });
});

describe('acceptsBareKey', () => {
  it('only accepts keys allowed by the definition', () => {
    expect(acceptsBareKey(undefined, 'Enter')).toBe(false);
    expect(acceptsBareKey('special', 'Enter')).toBe(true);
    expect(acceptsBareKey('special', 'A')).toBe(false);
    expect(acceptsBareKey('special', 'Space')).toBe(false);
    expect(acceptsBareKey('function', 'F5')).toBe(true);
    expect(acceptsBareKey('any', 'J')).toBe(true);
    expect(acceptsBareKey(['Delete', 'Backspace'], 'Delete')).toBe(true);
    expect(acceptsBareKey(['Delete', 'Backspace'], 'Enter')).toBe(false);
  });
});

describe('HOTKEY_DEFINITIONS', () => {
  it('has unique ids', () => {
    const ids = HOTKEY_DEFINITIONS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
