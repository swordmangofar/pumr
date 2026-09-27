import { formatTokenCount } from './format';

describe('formatTokenCount', () => {
  it('keeps small counts as plain integers', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('abbreviates thousands with one decimal', () => {
    expect(formatTokenCount(1_000)).toBe('1.0k');
    expect(formatTokenCount(12_300)).toBe('12.3k');
    expect(formatTokenCount(999_949)).toBe('999.9k');
  });

  it('abbreviates millions with one decimal', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
    expect(formatTokenCount(2_450_000)).toBe('2.5M');
  });
});
