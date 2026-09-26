/** Repair only the native exporter's unquoted reference to an existing mask. */
export function quoteNativeMaskReference(reference: string, maskIds: readonly string[]): string {
  const id = maskIds.find(id => reference === `url(#${id})`);
  if (id === undefined) return reference;
  // Quoted CSS strings must escape quotes/backslashes and line breaks. This
  // changes only the reference representation, never the actual native ID.
  const escaped = id.replace(/[\\"\n\r\f]/g, character => {
    if (character === '\\' || character === '"') return `\\${character}`;
    return `\\${character.charCodeAt(0).toString(16)} `;
  });
  return `url("#${escaped}")`;
}

export function repairNativeSvgMasks(svg: SVGSVGElement): void {
  const maskIds = Array.from(svg.querySelectorAll('mask[id]'), mask => mask.id);
  for (const element of svg.querySelectorAll('[mask]')) {
    const reference = element.getAttribute('mask')!;
    const quoted = quoteNativeMaskReference(reference, maskIds);
    if (quoted !== reference) element.setAttribute('mask', quoted);
  }
}
