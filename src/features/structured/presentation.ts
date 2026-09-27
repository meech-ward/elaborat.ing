import { GENERATED_FILL, GENERATED_STROKE } from './emitter.ts';
import { isGeneratedId } from './merge.ts';

/** The palette's diagram colours, as the canvas should store them for display. */
export type DiagramColors = {
  /** Shape outlines, arrows and labels. */
  stroke: string;
  /** Arrow labels. */
  label: string;
  /** Shapes. */
  fill: string;
  /** Shapes inside a container (the container itself is a frame, which has no fill). */
  fill2: string;
};

const FILLED = new Set(['rectangle', 'ellipse', 'diamond']);

/**
 * Generated shapes, arrows and labels in the palette's diagram colours,
 * for display only, where they still have the colours the generator gave
 * them. A colour the author set on the canvas, and anything drawn by hand,
 * keeps its own. Returns the same array when nothing changes.
 */
export function presentDiagramElements<T extends { id: string; type: string }>(elements: T[], colors: DiagramColors): T[] {
  const byId = new Map(elements.map((element) => [element.id, element]));
  let changed = false;
  const next = elements.map((element) => {
    if (!isGeneratedId(element.id)) return element;
    const fields = element as T & Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (fields.strokeColor === GENERATED_STROKE) {
      const container = typeof fields.containerId === 'string' ? byId.get(fields.containerId) : undefined;
      patch.strokeColor = element.type === 'text' && container?.type === 'arrow' ? colors.label : colors.stroke;
    }
    if (FILLED.has(element.type) && fields.backgroundColor === GENERATED_FILL) {
      patch.backgroundColor = fields.frameId ? colors.fill2 : colors.fill;
    }
    if (Object.keys(patch).length === 0) return element;
    changed = true;
    return { ...element, ...patch };
  });
  return changed ? next : elements;
}
