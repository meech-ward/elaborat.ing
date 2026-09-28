// What marks an element as generated from the D2 source, and the colours a
// generated element starts with. Apart from the emitter and the merge, so the
// canvas colours (presentation.ts), which the project page loads first, do not
// bring the compiler's code with them.

export const GENERATED_PREFIX = 'd2:';

export function isGeneratedId(id: string): boolean {
  return id.startsWith(GENERATED_PREFIX);
}

/**
 * The colours every generated element starts with (saved as these), unless
 * the D2 source sets its own. The canvas shows these in the palette's colours.
 */
export const GENERATED_STROKE = '#1e1e1e';
export const GENERATED_FILL = 'transparent';
