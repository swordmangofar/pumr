import { DestroyRef, Directive, ElementRef, afterRenderEffect, inject } from '@angular/core';
import { ThemeService } from '../core/theme.service';
import { ThemeColors } from '../core/themes';

interface Glow {
  /** Radii of the ellipse in rem. */
  readonly radiusX: number;
  readonly radiusY: number;
  /** Centre as a fraction of the window. */
  readonly x: number;
  readonly y: number;
  readonly color: 'navy' | 'accent';
  /** Opacity at the centre. */
  readonly strength: number;
  /** Fraction of the radius at which the glow has faded out. */
  readonly reach: number;
}

/**
 * The theme glows behind the panels, topmost first: the three gradients
 * `styles.css` paints on the root element. Keep both in step.
 */
export const BACKDROP_GLOWS: readonly Glow[] = [
  { radiusX: 55, radiusY: 34, x: 0.06, y: -0.12, color: 'navy', strength: 0.8, reach: 0.62 },
  { radiusX: 46, radiusY: 30, x: 0.98, y: 0.02, color: 'accent', strength: 0.16, reach: 0.58 },
  { radiusX: 72, radiusY: 42, x: 0.52, y: 1.22, color: 'navy', strength: 0.62, reach: 0.68 },
];

/** Longest side of the bitmap. The glows are smooth, so they stretch to any window. */
const MAX_SIDE = 512;

type BackdropColors = Pick<ThemeColors, 'ink' | 'navy' | 'accent'>;

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const channel = (at: number): number => Number.parseInt(value.slice(at, at + 2), 16) || 0;
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${alpha})`;
}

/** Paints the backdrop of a `width` by `height` window (CSS pixels) into the canvas. */
export function paintBackdrop(
  canvas: HTMLCanvasElement,
  colors: BackdropColors,
  width: number,
  height: number,
  rem: number,
): void {
  if (width <= 0 || height <= 0) {
    return;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  context.fillStyle = colors.ink;
  context.fillRect(0, 0, width, height);
  for (const glow of [...BACKDROP_GLOWS].reverse()) {
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
    gradient.addColorStop(0, hexToRgba(colors[glow.color], glow.strength));
    gradient.addColorStop(glow.reach, hexToRgba(colors[glow.color], 0));
    context.save();
    context.translate(glow.x * width, glow.y * height);
    context.scale(glow.radiusX * rem, glow.radiusY * rem);
    context.fillStyle = gradient;
    context.fillRect(-1, -1, 2, 2);
    context.restore();
  }
}

/**
 * Stands in for the theme gradient of the root element where the webview
 * paints on the CPU (see `RenderingService`). The gradient lies under every
 * translucent panel, so each repaint anywhere computes its three window-sized
 * layers again, which is most of what a repaint costs there. This canvas holds
 * the same picture as a bitmap that only has to be copied.
 */
@Directive({
  selector: 'canvas[appBackdrop]',
  host: { '(window:resize)': 'schedule()' },
})
export class BackdropCanvas {
  private readonly canvas = inject<ElementRef<HTMLCanvasElement>>(ElementRef).nativeElement;
  private readonly theme = inject(ThemeService);
  private frame = 0;

  constructor() {
    afterRenderEffect(() => this.paint(this.theme.current()));
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(this.frame));
  }

  /** Repaints once per frame while the window is being resized. */
  protected schedule(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.paint(this.theme.current()));
  }

  private paint(colors: BackdropColors): void {
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    paintBackdrop(this.canvas, colors, window.innerWidth, window.innerHeight, rem);
  }
}
