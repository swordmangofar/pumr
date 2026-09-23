import { describe, expect, it } from 'vitest';
import { formatHotkey, matchesHotkey } from './hotkeys';

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
