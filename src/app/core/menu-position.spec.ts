import { contextMenuStyle } from './menu-position';

describe('contextMenuStyle', () => {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;

  function viewport(width: number, height: number): void {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  }

  beforeEach(() => viewport(1000, 800));

  afterEach(() => viewport(originalWidth, originalHeight));

  it('opens at the pointer when the menu fits', () => {
    expect(contextMenuStyle(100, 200, 180, 240)).toEqual({
      left: '100px',
      top: '200px',
      bottom: 'auto',
    });
  });

  it('clamps horizontally so the menu keeps an 8px margin on the right', () => {
    expect(contextMenuStyle(950, 100, 200, 100)['left']).toBe('792px');
  });

  it('never positions the menu left of the margin', () => {
    expect(contextMenuStyle(-50, 100, 200, 100)['left']).toBe('8px');
    // A menu wider than the viewport still starts at the margin.
    expect(contextMenuStyle(10, 100, 1200, 100)['left']).toBe('8px');
  });

  it('flips upwards near the bottom edge and anchors to the pointer', () => {
    expect(contextMenuStyle(100, 700, 180, 240)).toEqual({
      left: '100px',
      top: 'auto',
      bottom: '100px',
    });
  });

  it('keeps the bottom margin when flipped at the very bottom', () => {
    expect(contextMenuStyle(100, 798, 180, 240)['bottom']).toBe('8px');
  });
});
