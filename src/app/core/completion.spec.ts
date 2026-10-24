import { best, fuzzyScore, matching, pathScore } from './completion';

/** The texts in the order the query ranks them, those that do not match left out. */
function ranked(query: string, texts: string[], score = fuzzyScore): string[] {
  return best(
    matching(texts, (text) => score(query, text)),
    texts.length,
  );
}

describe('fuzzyScore', () => {
  it('matches the characters in order, case aside', () => {
    expect(fuzzyScore('ces', 'composer-editor.service')).not.toBeNull();
    expect(fuzzyScore('ComposerEditor', 'composer-editor.service.ts')).not.toBeNull();
    expect(fuzzyScore('cex', 'composer-editor.service')).toBeNull();
  });

  it('matches everything alike for an empty query', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('wants the first character where a word starts', () => {
    // "j", "s", "o" and "n" are all in there, but no word starts with the "j".
    expect(fuzzyScore('json', 'project-settings.ts')).toBeNull();
    expect(fuzzyScore('ps', 'project-settings.ts')).not.toBeNull();
    expect(fuzzyScore('ed', 'ComposerEditor')).not.toBeNull();
  });

  it('ranks the whole text, then its start, a word in it, the inside and letters apart', () => {
    expect(ranked('edit', ['credited', 'reEdit', 'e-d-i-t', 'editor', 'edit'])).toEqual([
      'edit',
      'editor',
      'reEdit',
      'credited',
      'e-d-i-t',
    ]);
  });

  it('ranks the shorter of two equal matches first', () => {
    expect(ranked('comp', ['components', 'composer'])).toEqual(['composer', 'components']);
  });

  it('still matches when a word start further on would skip a letter it needs', () => {
    expect(fuzzyScore('abc', 'a-xbc-b')).not.toBeNull();
  });
});

describe('pathScore', () => {
  it('counts a match in the file name over one across the folders', () => {
    expect(
      ranked(
        'composer',
        ['src/composer/readme.md', 'src/app/components/composer.ts', 'src/app/composer-editor.ts'],
        pathScore,
      ),
    ).toEqual([
      'src/app/components/composer.ts',
      'src/app/composer-editor.ts',
      'src/composer/readme.md',
    ]);
  });

  it('matches a query with a slash against the whole path', () => {
    expect(pathScore('app/comp', 'src/app/components')).not.toBeNull();
    expect(pathScore('app/comp', 'src/core/components')).toBeNull();
  });
});

describe('best', () => {
  it('keeps the order of equal scores and stops at the limit', () => {
    expect(
      best(
        [
          { item: 'a', score: 1 },
          { item: 'b', score: 2 },
          { item: 'c', score: 1 },
        ],
        2,
      ),
    ).toEqual(['b', 'a']);
  });
});
