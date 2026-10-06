import { TestBed } from '@angular/core/testing';
import { PumaSpinner, SPINNER_CELLS, SPINNER_FRAMES } from './puma-spinner';

describe('PumaSpinner', () => {
  it('moves the tones around the ring by one cell per frame', () => {
    expect(SPINNER_FRAMES).toHaveLength(SPINNER_CELLS.length);
    SPINNER_FRAMES.forEach((frame, index) => {
      const next = SPINNER_FRAMES[(index + 1) % SPINNER_FRAMES.length];
      expect(frame.map(({ x, y }) => ({ x, y }))).toEqual(SPINNER_CELLS);
      // Each cell takes over the tone of the cell before it.
      expect(next.map((cell) => cell.opacity)).toEqual([
        frame[frame.length - 1].opacity,
        ...frame.slice(0, -1).map((cell) => cell.opacity),
      ]);
      expect(frame.filter((cell) => cell.opacity === 1)).toHaveLength(1);
    });
  });

  it('renders whole frames, so a step repaints the spinner as one area', () => {
    const fixture = TestBed.createComponent(PumaSpinner);
    fixture.detectChanges();
    const svg: SVGElement = fixture.nativeElement.querySelector('svg');

    const frames = Array.from(svg.querySelectorAll('g'));
    expect(frames.map((frame) => frame.getAttribute('class'))).toEqual(
      SPINNER_CELLS.map((_, index) => `puma-frame puma-frame-${index}`),
    );
    for (const frame of frames) {
      expect(frame.querySelectorAll('rect')).toHaveLength(SPINNER_CELLS.length);
    }
    // Nothing below a frame animates on its own.
    expect(svg.querySelector('rect[class], rect[style]')).toBeNull();
  });

  it('comes in two sizes', () => {
    const fixture = TestBed.createComponent(PumaSpinner);
    fixture.detectChanges();
    const svg: SVGElement = fixture.nativeElement.querySelector('svg');
    expect(svg.getAttribute('class')).toBe('puma-spinner h-5 w-5');

    fixture.componentRef.setInput('small', true);
    fixture.detectChanges();
    expect(svg.getAttribute('class')).toBe('puma-spinner h-3 w-3');
  });
});
