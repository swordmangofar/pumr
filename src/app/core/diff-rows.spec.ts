import { describe, expect, it } from 'vitest';
import {
  changeIds,
  colorizedLines,
  cursorStops,
  findRows,
  hunkSides,
  markSegments,
  rangeIds,
  rowAt,
  rowOffsets,
  rowOfLine,
  selectionPatch,
  selectionRange,
  selectionText,
  splitRows,
  unifiedRows,
  wrappedLines,
} from './diff-rows';
import { GitDiffLine, GitDiffLineKind, GitHunkDiff } from './models';

let nextId = 0;

function line(
  kind: GitDiffLineKind,
  text: string,
  oldLine: number | null,
  newLine: number | null,
): GitDiffLine {
  return { id: nextId++, kind, oldLine, newLine, text, noNewline: false };
}

/** Two hunks: a replaced line plus an addition, and a lone removal. */
function sample(): GitHunkDiff {
  nextId = 0;
  return {
    path: 'src/a.ts',
    staged: false,
    status: 'M',
    language: 'typescript',
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        section: '',
        lines: [
          line('context', 'one', 1, 1),
          line('del', 'two', 2, null),
          line('add', 'TWO', null, 2),
          line('add', 'extra', null, 3),
          line('context', 'three', 3, 4),
        ],
      },
      {
        oldStart: 10,
        oldLines: 2,
        newStart: 11,
        newLines: 1,
        section: 'function tail()',
        lines: [line('context', 'ten', 10, 11), line('del', 'eleven', 11, null)],
      },
    ],
    additions: 2,
    deletions: 2,
    binary: false,
    tooLarge: false,
    blocked: null,
    fingerprint: 'fp',
  };
}

describe('diff rows', () => {
  it('lists a header per hunk and one row per line in the unified layout', () => {
    const rows = unifiedRows(sample());
    expect(rows.map((row) => row.type)).toEqual([
      'hunk',
      'line',
      'line',
      'line',
      'line',
      'line',
      'hunk',
      'line',
      'line',
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('pairs removed and added lines side by side in the split layout', () => {
    const rows = splitRows(sample());
    const pairs = rows.map((row) =>
      row.type === 'pair' ? [row.left?.text ?? null, row.right?.text ?? null] : 'hunk',
    );
    expect(pairs).toEqual([
      'hunk',
      ['one', 'one'],
      ['two', 'TWO'],
      [null, 'extra'],
      ['three', 'three'],
      'hunk',
      ['ten', 'ten'],
      ['eleven', null],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('selects only changed lines of a range, and one side in the split layout', () => {
    const diff = sample();
    const unified = unifiedRows(diff);
    expect(rangeIds(unified, 5, 1, 'both')).toEqual([1, 2, 3]);

    const split = splitRows(diff);
    expect(rangeIds(split, 1, 4, 'left')).toEqual([1]);
    expect(rangeIds(split, 1, 4, 'right')).toEqual([2, 3]);
    expect(rangeIds(split, 0, split.length - 1, 'both')).toEqual(changeIds(diff));
  });

  it('walks the keyboard cursor over changed lines, left before right', () => {
    const split = splitRows(sample());
    expect(cursorStops(split).map((stop) => [stop.id, stop.side])).toEqual([
      [1, 'left'],
      [2, 'right'],
      [3, 'right'],
      [6, 'left'],
    ]);
    expect(rowOfLine(split, 3)).toBe(3);
  });

  it('finds the row at a position from row offsets', () => {
    const { offsets, total } = rowOffsets([28, 20, 20, 40]);
    expect(offsets).toEqual([0, 28, 48, 68]);
    expect(total).toBe(108);
    expect(rowAt(offsets, 0)).toBe(0);
    expect(rowAt(offsets, 27)).toBe(0);
    expect(rowAt(offsets, 28)).toBe(1);
    expect(rowAt(offsets, 500)).toBe(3);
    expect(rowAt(offsets, -5)).toBe(0);
    expect(rowAt([], 10)).toBe(-1);
  });

  it('counts wrapped lines with tabs expanded', () => {
    expect(wrappedLines('', 10, 4)).toBe(1);
    expect(wrappedLines('x'.repeat(21), 10, 4)).toBe(3);
    expect(wrappedLines('\tabcdefg', 10, 4)).toBe(2);
    expect(wrappedLines('abc', 0, 4)).toBe(1);
  });

  it('finds rows and marks matches ignoring case', () => {
    const rows = unifiedRows(sample());
    expect(findRows(rows, 'TWO')).toEqual([2, 3]);
    expect(findRows(rows, '')).toEqual([]);
    expect(markSegments('Two two', 'two')).toEqual([
      { text: 'Two', mark: true },
      { text: ' ', mark: false },
      { text: 'two', mark: true },
    ]);
  });

  it('describes a selection for the clipboard and the chat', () => {
    const diff = sample();
    const selected = new Set([2, 3, 6]);
    expect(selectionText(diff, selected)).toBe('TWO\nextra\neleven');
    expect(selectionRange(diff, selected)).toEqual({ from: 2, to: 11 });
    expect(selectionPatch(diff, new Set([1, 3]))).toBe('-two\n+TWO\n+extra');
    expect(selectionPatch(diff, selected)).toBe('+TWO\n+extra\n…\n-eleven');
  });

  it('splits a hunk into its old and new texts for colorizing', () => {
    const sides = hunkSides(sample().hunks[0]);
    expect(sides.old).toEqual({ ids: [0, 1, 4], text: 'one\ntwo\nthree' });
    expect(sides.new).toEqual({ ids: [0, 2, 3, 4], text: 'one\nTWO\nextra\nthree' });
  });

  it('splits colorized html into lines and refuses a mismatch', () => {
    expect(colorizedLines('<span>a</span><br/><span>b</span><br/>', 2)).toEqual([
      '<span>a</span>',
      '<span>b</span>',
    ]);
    expect(colorizedLines('<span>a</span><br/>', 2)).toBeNull();
  });
});
