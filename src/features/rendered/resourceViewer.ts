/**
 * Reading-only resource viewer logic (no React, no browser globals).
 *
 * Zoom/pan state is local view state only: changing it never edits a file.
 * The view starts fitted (scale 1 with the image constrained to the
 * viewport) and stays within explicit bounds so controls cannot lose the
 * image on desktop or a 390px phone.
 */

/** Smallest scale: the image stays recognizable, never an invisible dot. */
export const MIN_VIEW_SCALE = 0.25;
/** Largest scale: crisp SVG pixels without runaway transform values. */
export const MAX_VIEW_SCALE = 8;
/** One zoom button step (in or out). */
export const VIEW_ZOOM_STEP = 1.25;

export type ResourceView = {
  /** Multiplicative zoom; 1 is fitted. */
  scale: number;
  /** Pan offset in CSS pixels. */
  x: number;
  /** Pan offset in CSS pixels. */
  y: number;
};

/** The fitted view every opening starts from. */
export const INITIAL_VIEW: ResourceView = { scale: 1, x: 0, y: 0 };

/** A fresh fitted view (Fit control and dialog open reset here). */
export function fitView(): ResourceView {
  return { ...INITIAL_VIEW };
}

/** Open at reading width; tall drawings start at the top rather than shrinking
 * to fit their entire height. The explicit Fit action still shows everything. */
export function fitWidthView(width: number, height: number, aspect: number): ResourceView {
  if (width <= 0 || height <= 0 || aspect <= 0) return fitView();
  const fittedWidth = Math.min(width, height * aspect);
  const scale = width / fittedWidth;
  return { scale, x: 0, y: Math.max(0, (fittedWidth / aspect * scale - height) / 2) };
}

/** Clamp a scale into the supported viewer range. */
export function clampViewScale(scale: number, maximum = MAX_VIEW_SCALE): number {
  if (!Number.isFinite(scale)) return INITIAL_VIEW.scale;
  return Math.min(maximum, Math.max(MIN_VIEW_SCALE, scale));
}

/** One zoom step from the current scale, clamped to the bounds. */
export function stepViewScale(
  scale: number,
  direction: "in" | "out",
  maximum = MAX_VIEW_SCALE,
): number {
  const base = clampViewScale(scale, maximum);
  const next =
    direction === "in" ? base * VIEW_ZOOM_STEP : base / VIEW_ZOOM_STEP;
  return clampViewScale(next, maximum);
}

/** Keep the same image point under a moving zoom/pinch anchor.
 * Points are CSS pixels relative to the viewport centre, like the pan offset.
 */
export function scaleViewAt(
  view: ResourceView,
  requestedScale: number,
  from: { x: number; y: number },
  to = from,
  maximum = MAX_VIEW_SCALE,
): ResourceView {
  const scale = clampViewScale(requestedScale, maximum);
  const ratio = scale / view.scale;
  return {
    scale,
    x: to.x - (from.x - view.x) * ratio,
    y: to.y - (from.y - view.y) * ratio,
  };
}
