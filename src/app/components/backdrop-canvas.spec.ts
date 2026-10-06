import { BACKDROP_GLOWS, paintBackdrop } from './backdrop-canvas';

const COLORS = { ink: '#000000', navy: '#1e293b', accent: '#f59e0b' };

interface Fill {
  style: unknown;
  rect: number[];
  translate: number[];
  scale: number[];
}

/** A 2D context that records what is filled, with which style and transform. */
function recordingContext() {
  const fills: Fill[] = [];
  const stops: [number, string][][] = [];
  let translate: number[] = [];
  let scale: number[] = [];
  const context = {
    fillStyle: '' as unknown,
    setTransform: vi.fn(),
    save: () => {},
    restore: () => {
      translate = [];
      scale = [];
    },
    translate: (x: number, y: number) => {
      translate = [x, y];
    },
    scale: (x: number, y: number) => {
      scale = [x, y];
    },
    createRadialGradient: (...circles: number[]) => {
      const gradient: [number, string][] = [];
      stops.push(gradient);
      return { circles, addColorStop: (at: number, color: string) => gradient.push([at, color]) };
    },
    fillRect: (...rect: number[]) => {
      fills.push({ style: context.fillStyle, rect, translate, scale });
    },
  };
  return { context, fills, stops };
}

describe('paintBackdrop', () => {
  let canvas: HTMLCanvasElement;
  let recorded: ReturnType<typeof recordingContext>;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    recorded = recordingContext();
    vi.spyOn(canvas, 'getContext').mockReturnValue(
      recorded.context as unknown as CanvasRenderingContext2D,
    );
  });

  it('keeps the bitmap small and in the shape of the window', () => {
    paintBackdrop(canvas, COLORS, 1440, 920, 16);
    expect([canvas.width, canvas.height]).toEqual([512, 327]);
    // Drawing happens in window coordinates.
    expect(recorded.context.setTransform).toHaveBeenCalledWith(512 / 1440, 0, 0, 327 / 920, 0, 0);

    paintBackdrop(canvas, COLORS, 400, 300, 16);
    expect([canvas.width, canvas.height]).toEqual([400, 300]);
  });

  it('fills the ink colour and lays the glows over it, the topmost one last', () => {
    paintBackdrop(canvas, COLORS, 1000, 500, 16);

    const [base, ...glows] = recorded.fills;
    expect(base).toMatchObject({ style: '#000000', rect: [0, 0, 1000, 500] });
    expect(glows).toHaveLength(BACKDROP_GLOWS.length);
    // Centre and radii of each ellipse, from the window size and the rem.
    expect(glows.map((glow) => [...glow.translate, ...glow.scale])).toEqual([
      [520, 610, 72 * 16, 42 * 16],
      [980, 10, 46 * 16, 30 * 16],
      [60, -60, 55 * 16, 34 * 16],
    ]);
    // Every glow fades from its strength to nothing in its own colour.
    expect(recorded.stops).toEqual([
      [
        [0, 'rgba(30, 41, 59, 0.62)'],
        [0.68, 'rgba(30, 41, 59, 0)'],
      ],
      [
        [0, 'rgba(245, 158, 11, 0.16)'],
        [0.58, 'rgba(245, 158, 11, 0)'],
      ],
      [
        [0, 'rgba(30, 41, 59, 0.8)'],
        [0.62, 'rgba(30, 41, 59, 0)'],
      ],
    ]);
  });

  it('leaves the canvas alone while the window has no size', () => {
    paintBackdrop(canvas, COLORS, 0, 920, 16);
    expect(recorded.fills).toEqual([]);
  });
});
