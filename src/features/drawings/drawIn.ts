// Elements that arrive in a version saved elsewhere, such as an agent drawing
// a few elements at a time, are sketched in rather than popping in
// (sketchIn.ts): the canvas shows them hidden until each one is drawn.
// Display only: the scene the canvas reports, saves and compares keeps each
// element's own opacity (DrawingCanvas's `drawIn`).

import type { DrawingScene } from './types.ts';

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

/** The elements, with these opacities in place of their own. */
export function withOpacities<T extends { id: string }>(elements: readonly T[], opacities: ReadonlyMap<string, number>): T[] {
  return elements.map((element) => {
    const opacity = opacities.get(element.id);
    return opacity === undefined ? element : { ...element, opacity };
  });
}
