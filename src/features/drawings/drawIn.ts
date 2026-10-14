// Elements that arrive in a version saved elsewhere, such as an agent drawing
// a few elements at a time, draw in rather than pop in: each fades from
// nothing to its own opacity, one after another in the scene's order.
// Display only: the canvas shows the fade, while the scene it reports, saves
// and compares keeps each element's own opacity (DrawingCanvas's `drawIn`).

import type { DrawingScene } from './types.ts';

/** How long one element takes to fade in, in milliseconds. */
const FADE_MS = 300;
/** How long after one element the next one starts. */
const STAGGER_MS = 60;
/** The latest the last element starts, however many arrive at once. */
const LAST_START_MS = 1200;

/** The live elements `after` has that `before` does not, by id in scene order, with the opacity each ends at. */
export function arrivingElements(before: DrawingScene, after: DrawingScene): Map<string, number> {
  const known = new Set(before.elements.map((element) => element.id));
  const arriving = new Map<string, number>();
  for (const element of after.elements) {
    if (known.has(element.id) || element.isDeleted === true) continue;
    arriving.set(element.id, typeof element.opacity === 'number' ? element.opacity : 100);
  }
  return arriving;
}

/**
 * Each arriving element's opacity `elapsed` milliseconds into the draw-in,
 * easing out to its own; null once every one has reached its own.
 */
export function drawInOpacities(arriving: ReadonlyMap<string, number>, elapsed: number): Map<string, number> | null {
  const stagger = Math.min(STAGGER_MS, LAST_START_MS / Math.max(1, arriving.size));
  const shown = new Map<string, number>();
  let done = true;
  let order = 0;
  for (const [id, own] of arriving) {
    const progress = Math.min(1, Math.max(0, (elapsed - order * stagger) / FADE_MS));
    if (progress < 1) done = false;
    shown.set(id, own * (1 - (1 - progress) ** 3));
    order += 1;
  }
  return done ? null : shown;
}

/** The elements, with these opacities in place of their own. */
export function withOpacities<T extends { id: string }>(elements: readonly T[], opacities: ReadonlyMap<string, number>): T[] {
  return elements.map((element) => {
    const opacity = opacities.get(element.id);
    return opacity === undefined ? element : { ...element, opacity };
  });
}
