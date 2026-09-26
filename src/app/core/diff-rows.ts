import { GitDiffHunk, GitDiffLine, GitHunkDiff } from './models';

/** A hunk's `@@` header. */
export interface HunkRow {
  type: 'hunk';
  key: string;
  hunk: number;
}

/** One line of the unified layout. */
export interface LineRow {
  type: 'line';
  key: string;
  hunk: number;
  line: GitDiffLine;
}

/** One row of the split layout: the old line on the left, the new on the right. */
export interface PairRow {
  type: 'pair';
  key: string;
  hunk: number;
  left: GitDiffLine | null;
  right: GitDiffLine | null;
}

export type DiffRow = HunkRow | LineRow | PairRow;

/** Which lines of a row a pointer or range refers to. */
export type DiffSide = 'left' | 'right' | 'both';

export function isChange(line: GitDiffLine | null | undefined): line is GitDiffLine {
  return !!line && line.kind !== 'context';
}

export function unifiedRows(diff: GitHunkDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  diff.hunks.forEach((hunk, index) => {
    rows.push({ type: 'hunk', key: `h${index}`, hunk: index });
    for (const line of hunk.lines) {
      rows.push({ type: 'line', key: `l${line.id}`, hunk: index, line });
    }
  });
  return rows;
}

/**
 * Pairs each run of removed lines with the added lines that follow it, the
 * way side-by-side diffs line up a changed block.
 */
export function splitRows(diff: GitHunkDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  diff.hunks.forEach((hunk, index) => {
    rows.push({ type: 'hunk', key: `h${index}`, hunk: index });
    let removed: GitDiffLine[] = [];
    let added: GitDiffLine[] = [];
    const flush = () => {
      for (let i = 0; i < Math.max(removed.length, added.length); i += 1) {
        const left = removed[i] ?? null;
        const right = added[i] ?? null;
        rows.push({ type: 'pair', key: `p${(left ?? right)!.id}`, hunk: index, left, right });
      }
      removed = [];
      added = [];
    };
    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        flush();
        rows.push({ type: 'pair', key: `p${line.id}`, hunk: index, left: line, right: line });
      } else if (line.kind === 'del') {
        if (added.length > 0) {
          flush();
        }
        removed.push(line);
      } else {
        added.push(line);
      }
    }
    flush();
  });
  return rows;
}

/** The lines of a row on one side; a unified row has one line for both. */
export function rowLines(row: DiffRow, side: DiffSide): GitDiffLine[] {
  if (row.type === 'line') {
    return [row.line];
  }
  if (row.type === 'hunk') {
    return [];
  }
  const lines: GitDiffLine[] = [];
  if (side !== 'right' && row.left) {
    lines.push(row.left);
  }
  if (side !== 'left' && row.right && row.right !== row.left) {
    lines.push(row.right);
  }
  return lines;
}

export function hunkChangeIds(hunk: GitDiffHunk): number[] {
  return hunk.lines.filter(isChange).map((line) => line.id);
}

export function changeIds(diff: GitHunkDiff): number[] {
  return diff.hunks.flatMap(hunkChangeIds);
}

/** The changed lines on `side` of the rows from `from` to `to`, in either order. */
export function rangeIds(rows: DiffRow[], from: number, to: number, side: DiffSide): number[] {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(rows.length - 1, Math.max(from, to));
  const ids: number[] = [];
  for (let index = start; index <= end; index += 1) {
    for (const line of rowLines(rows[index], side)) {
      if (isChange(line)) {
        ids.push(line.id);
      }
    }
  }
  return ids;
}

/** A changed line the keyboard cursor can stand on. */
export interface CursorStop {
  row: number;
  side: DiffSide;
  id: number;
}

/** Every changed line in display order; in split rows the left comes first. */
export function cursorStops(rows: DiffRow[]): CursorStop[] {
  const stops: CursorStop[] = [];
  rows.forEach((row, index) => {
    if (row.type === 'line') {
      if (isChange(row.line)) {
        stops.push({ row: index, side: 'both', id: row.line.id });
      }
    } else if (row.type === 'pair') {
      if (isChange(row.left)) {
        stops.push({ row: index, side: 'left', id: row.left.id });
      }
      if (isChange(row.right) && row.right !== row.left) {
        stops.push({ row: index, side: 'right', id: row.right.id });
      }
    }
  });
  return stops;
}

/** The row that holds a line, or -1. */
export function rowOfLine(rows: DiffRow[], id: number): number {
  return rows.findIndex((row) =>
    row.type === 'line'
      ? row.line.id === id
      : row.type === 'pair' && (row.left?.id === id || row.right?.id === id),
  );
}

/** Tops of rows of the given heights, plus the total height. */
export function rowOffsets(heights: number[]): { offsets: number[]; total: number } {
  const offsets = new Array<number>(heights.length);
  let total = 0;
  for (let index = 0; index < heights.length; index += 1) {
    offsets[index] = total;
    total += heights[index];
  }
  return { offsets, total };
}

/** The row at vertical position `y`, clamped to the rows that exist. */
export function rowAt(offsets: number[], y: number): number {
  let low = 0;
  let high = offsets.length - 1;
  if (high < 0) {
    return -1;
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= y) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** Columns a line takes, with tabs expanded to the next tab stop. */
export function visualLength(text: string, tabSize: number): number {
  let column = 0;
  for (const char of text) {
    column = char === '\t' ? column + tabSize - (column % tabSize) : column + 1;
  }
  return column;
}

/** How many screen lines a line wraps to at `columns` characters per line. */
export function wrappedLines(text: string, columns: number, tabSize: number): number {
  if (columns <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(visualLength(text, tabSize) / columns));
}

/** Rows whose text contains `query`, ignoring case. */
export function findRows(rows: DiffRow[], query: string): number[] {
  const needle = query.toLowerCase();
  if (!needle) {
    return [];
  }
  const matches: number[] = [];
  rows.forEach((row, index) => {
    if (rowLines(row, 'both').some((line) => line.text.toLowerCase().includes(needle))) {
      matches.push(index);
    }
  });
  return matches;
}

export interface TextSegment {
  text: string;
  mark: boolean;
}

/** Splits `text` into plain and matching parts, ignoring case. */
export function markSegments(text: string, query: string): TextSegment[] {
  const needle = query.toLowerCase();
  if (!needle) {
    return [{ text, mark: false }];
  }
  const lower = text.toLowerCase();
  const segments: TextSegment[] = [];
  let position = 0;
  for (
    let found = lower.indexOf(needle);
    found >= 0;
    found = lower.indexOf(needle, found + needle.length)
  ) {
    if (found > position) {
      segments.push({ text: text.slice(position, found), mark: false });
    }
    segments.push({ text: text.slice(found, found + needle.length), mark: true });
    position = found + needle.length;
  }
  if (position < text.length) {
    segments.push({ text: text.slice(position), mark: false });
  }
  return segments;
}

/** The text of the chosen lines in display order, for the clipboard. */
export function selectionText(diff: GitHunkDiff, selected: ReadonlySet<number>): string {
  return diff.hunks
    .flatMap((hunk) => hunk.lines)
    .filter((line) => selected.has(line.id))
    .map((line) => line.text)
    .join('\n');
}

/** First and last line number the chosen lines cover, new numbers first. */
export function selectionRange(
  diff: GitHunkDiff,
  selected: ReadonlySet<number>,
): { from: number; to: number } | null {
  const numbers = diff.hunks
    .flatMap((hunk) => hunk.lines)
    .filter((line) => selected.has(line.id))
    .map((line) => line.newLine ?? line.oldLine)
    .filter((value): value is number => value !== null);
  return numbers.length > 0 ? { from: Math.min(...numbers), to: Math.max(...numbers) } : null;
}

/**
 * The chosen lines as a unified diff excerpt, from the first to the last
 * chosen line of each hunk with the context between them.
 */
export function selectionPatch(diff: GitHunkDiff, selected: ReadonlySet<number>): string {
  const parts: string[] = [];
  for (const hunk of diff.hunks) {
    const first = hunk.lines.findIndex((line) => selected.has(line.id));
    if (first < 0) {
      continue;
    }
    let last = first;
    hunk.lines.forEach((line, index) => {
      if (selected.has(line.id)) {
        last = index;
      }
    });
    if (parts.length > 0) {
      parts.push('…');
    }
    for (const line of hunk.lines.slice(first, last + 1)) {
      const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      parts.push(`${sign}${line.text}`);
    }
  }
  return parts.join('\n');
}

/** Old and new texts of a hunk and the lines they hold, for colorizing each side. */
export function hunkSides(hunk: GitDiffHunk): {
  old: { ids: number[]; text: string };
  new: { ids: number[]; text: string };
} {
  const oldLines = hunk.lines.filter((line) => line.kind !== 'add');
  const newLines = hunk.lines.filter((line) => line.kind !== 'del');
  return {
    old: {
      ids: oldLines.map((line) => line.id),
      text: oldLines.map((line) => line.text).join('\n'),
    },
    new: {
      ids: newLines.map((line) => line.id),
      text: newLines.map((line) => line.text).join('\n'),
    },
  };
}

/** Splits colorized HTML (one `<br/>` after each line) into its lines. */
export function colorizedLines(html: string, count: number): string[] | null {
  const lines = html.split('<br/>');
  // The `<br/>` after the last line leaves one empty piece.
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length === count ? lines : null;
}
