/**
 * The clear space the canvas keeps around an arrow's label (Excalidraw's
 * BOUND_TEXT_PADDING), so the line stops short of the words.
 */
export const LABEL_GAP = 5;

/** Repair only the native exporter's unquoted reference to a mask, pointing it at the mask's id in `renamed`. */
export function quoteNativeMaskReference(reference: string, renamed: ReadonlyMap<string, string>): string {
  const original = [...renamed.keys()].find(id => reference === `url(#${id})`);
  if (original === undefined) return reference;
  // Quoted CSS strings must escape quotes/backslashes and line breaks.
  const escaped = renamed.get(original)!.replace(/[\\"\n\r\f]/g, character => {
    if (character === '\\' || character === '"') return `\\${character}`;
    return `\\${character.charCodeAt(0).toString(16)} `;
  });
  return `url("#${escaped}")`;
}

/**
 * A mask id no other picture on the page shares. The exporter names an
 * arrow's mask after the arrow, and D2 names arrows after their ends, so two
 * diagrams in one note can both have `mask-d2:(a -> b)[0]`; the browser then
 * masks both arrows with one of them, hiding lines and missing labels. The
 * suffix comes from what the mask holds, so two ids stay equal only when the
 * masks are the same.
 */
export function uniqueMaskId(id: string, content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index++) hash = Math.imul(hash ^ content.charCodeAt(index), 0x01000193);
  return `${id}-${(hash >>> 0).toString(36)}`;
}

type Box = { x: number; y: number; width: number; height: number };

/** A label's cutout grown by LABEL_GAP on every side. */
export function paddedCutout({ x, y, width, height }: Box): Box {
  return { x: x - LABEL_GAP, y: y - LABEL_GAP, width: width + 2 * LABEL_GAP, height: height + 2 * LABEL_GAP };
}

/**
 * Arrow labels in the native SVG: each arrow's mask hides the line under its
 * label, with the canvas's gap around the words, under an id of its own.
 */
export function repairNativeSvgMasks(svg: SVGSVGElement): void {
  const renamed = new Map<string, string>();
  for (const mask of svg.querySelectorAll('mask[id]')) {
    // The exporter's mask for a label: a white rect that shows the arrow, then a black one over the label.
    const cutout = mask.querySelector('rect[fill="#000"]');
    if (cutout) {
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(name => Number(cutout.getAttribute(name)));
      const box = paddedCutout({ x, y, width, height });
      if (Object.values(box).every(Number.isFinite)) for (const [name, value] of Object.entries(box)) cutout.setAttribute(name, String(value));
    }
    const id = uniqueMaskId(mask.id, mask.innerHTML);
    renamed.set(mask.id, id);
    mask.id = id;
  }
  for (const element of svg.querySelectorAll('[mask]')) {
    const reference = element.getAttribute('mask')!;
    const quoted = quoteNativeMaskReference(reference, renamed);
    if (quoted !== reference) element.setAttribute('mask', quoted);
  }
}
