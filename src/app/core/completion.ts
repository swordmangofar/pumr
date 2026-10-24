/**
 * Ranking for what the composer completes: files, folders and the names a
 * project defines. A query matches when its characters appear in the text in
 * order, as "ces" does in "composer-editor.service". A match that is the whole
 * text, starts it, starts a word in it or holds the query in one piece ranks
 * higher; among equals the shorter text wins.
 */

/** Characters after which a new word of a name or a path begins. */
const SEPARATORS = /[/\\._\-\s:]/;

/** A query found in one piece ranks above one spread out, whatever the lengths. */
const EXACT = 5000;
const PREFIX = 4000;
const WORD = 3000;
const INSIDE = 2000;
const APART = 1000;

/**
 * What a match across a path's folders is worth less than one in its own
 * name, which then scores as a name alone does, a symbol's included.
 */
const FOLDER_DISCOUNT = 100;

export interface Ranked<T> {
  item: T;
  score: number;
}

/**
 * Whether a word of `text` begins at `index`: at its start, after a separator,
 * or at a capital that follows a small letter (`Editor` in `ComposerEditor`).
 */
function startsWord(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const previous = text[index - 1];
  if (SEPARATORS.test(previous)) {
    return true;
  }
  const char = text[index];
  const capital = char !== char.toLowerCase();
  const small = previous !== previous.toUpperCase();
  return capital && small;
}

/** Longer texts rank lower, but never by as much as a tier. */
function lengthPenalty(text: string): number {
  return Math.min(text.length, 500);
}

/**
 * Scores the query's characters spread over the text. The first has to start
 * a word, or every name that holds the letters somewhere would come up. With
 * `wordStarts`, a character that does not follow the one before is looked
 * for where a word starts first; that can skip letters a later character
 * needs, so a miss then is tried again without it.
 */
function apart(needle: string, text: string, haystack: string, wordStarts: boolean): number | null {
  let previous = -1;
  let score = 0;
  for (let position = 0; position < needle.length; position += 1) {
    const char = needle[position];
    let index = -1;
    if (position > 0 && haystack[previous + 1] === char) {
      index = previous + 1;
      score += 20;
    } else {
      const first = position === 0;
      for (
        let at = haystack.indexOf(char, previous + 1);
        at >= 0;
        at = haystack.indexOf(char, at + 1)
      ) {
        if (startsWord(text, at)) {
          index = at;
          break;
        }
        if (!first && !wordStarts) {
          index = at;
          break;
        }
      }
      if (index < 0) {
        return null;
      }
      score += startsWord(text, index) ? 30 : -5;
    }
    previous = index;
  }
  return APART + score - lengthPenalty(text);
}

/**
 * How well `query` matches `text`, case aside: higher is better, `null` is no
 * match. An empty query matches everything alike.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (query === '') {
    return 0;
  }
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  if (haystack === needle) {
    return EXACT;
  }
  const at = haystack.indexOf(needle);
  if (at === 0) {
    return PREFIX - lengthPenalty(text);
  }
  if (at > 0) {
    return (startsWord(text, at) ? WORD : INSIDE) - lengthPenalty(text);
  }
  return apart(needle, text, haystack, true) ?? apart(needle, text, haystack, false);
}

/**
 * How well `query` matches a project path. Its file or folder name counts
 * most; a query with a slash in it is matched against the whole path.
 */
export function pathScore(query: string, path: string): number | null {
  const inPath = fuzzyScore(query, path);
  if (query.includes('/')) {
    return inPath;
  }
  const inName = fuzzyScore(query, path.slice(path.lastIndexOf('/') + 1));
  const acrossFolders = inPath === null ? null : inPath - FOLDER_DISCOUNT;
  if (inName === null) {
    return acrossFolders;
  }
  return Math.max(inName, acrossFolders ?? -Infinity);
}

/** The items that match, each with its score, in their own order. */
export function matching<T>(items: readonly T[], score: (item: T) => number | null): Ranked<T>[] {
  const found: Ranked<T>[] = [];
  for (const item of items) {
    const value = score(item);
    if (value !== null) {
      found.push({ item, score: value });
    }
  }
  return found;
}

/** The `limit` best items; equal scores keep their order. */
export function best<T>(ranked: readonly Ranked<T>[], limit: number): T[] {
  return [...ranked]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}
