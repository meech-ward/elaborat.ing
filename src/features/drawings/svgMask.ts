/**
 * The clear space the canvas keeps around an arrow's label (Excalidraw's
 * BOUND_TEXT_PADDING), so the line stops short of the words.
 */
export const LABEL_GAP = 5;

/** A CSS reference to the element with this id, quoted so any id survives. */
export function cssUrl(id: string): string {
  // Quoted CSS strings must escape quotes/backslashes and line breaks.
  const escaped = id.replace(/[\\"\n\r\f]/g, character => {
    if (character === '\\' || character === '"') return `\\${character}`;
    return `\\${character.charCodeAt(0).toString(16)} `;
  });
  return `url("#${escaped}")`;
}

/** Repair only the native exporter's unquoted reference to a mask, pointing it at the mask's id in `renamed`. */
export function quoteNativeMaskReference(reference: string, renamed: ReadonlyMap<string, string>): string {
  const original = [...renamed.keys()].find(id => reference === `url(#${id})`);
  if (original === undefined) return reference;
  return cssUrl(renamed.get(original)!);
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

/** `url(...)`, quoted with either quote or bare. */
const URL_REFERENCE = /url\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|([^\s"')]*))\s*\)/g;

const unescapeCss = (text: string) =>
  text.replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_, escape: string) =>
    /^[0-9a-fA-F]/.test(escape) ? String.fromCodePoint(Math.min(parseInt(escape, 16), 0x10ffff)) : escape);

/**
 * An attribute's references to ids in the same picture, pointed at their new
 * ids in `renamed`: `#id` in an href, and `url(#id)`, quoted or not, in any
 * other attribute. Everything else comes back unchanged.
 */
export function renameSvgReference(name: string, value: string, renamed: ReadonlyMap<string, string>): string {
  if (name === 'href') {
    const id = value.startsWith('#') ? renamed.get(value.slice(1)) : undefined;
    return id === undefined ? value : `#${id}`;
  }
  if (!value.includes('url(')) return value;
  return value.replace(URL_REFERENCE, (reference, double?: string, single?: string, bare?: string) => {
    const target = unescapeCss(double ?? single ?? bare ?? '');
    const id = target.startsWith('#') ? renamed.get(target.slice(1)) : undefined;
    return id === undefined ? reference : cssUrl(id);
  });
}

/**
 * Gives each id in one copy of a picture the copy's own `scope`, and points
 * the copy's references at the new ids. Ids belong to the whole page, so a
 * note showing the same diagram twice would have two masks with one id, and
 * the browser would draw both copies with the first copy's masks (hide that
 * copy, and a line runs through the second copy's labels).
 */
export function scopeSvgIds(root: Element, scope: string): void {
  const renamed = new Map<string, string>();
  for (const element of root.querySelectorAll('[id]')) {
    const id = `${element.id}-${scope}`;
    renamed.set(element.id, id);
    element.id = id;
  }
  if (renamed.size === 0) return;
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      const value = renameSvgReference(attribute.localName, attribute.value, renamed);
      if (value !== attribute.value) attribute.value = value;
    }
  }
}
