import type { D2Diagram, GeneratedBaseline, NativeScene } from './types.ts';
import { hashSource } from './sourceHash.ts';

export type LabelEdit = { elementId: string; before: string; after: string; rendered?: string };
export type LabelSyncResult = { source: string; baseline: GeneratedBaseline; error: string | null };

export function isNodeLabel(edit: LabelEdit, baseline: GeneratedBaseline): boolean {
  if (!edit.elementId.endsWith(':label')) return false;
  const owner = baseline.elements[edit.elementId.slice(0, -':label'.length)];
  return !!owner && owner.snapshot.type !== 'arrow';
}

/** Only existing generated text is semantic. Free text is never inferred. */
export function changedGeneratedLabels(previous: NativeScene, next: NativeScene, baseline: GeneratedBaseline): LabelEdit[] {
  const before = new Map(previous.elements.map(el => [el.id, el]));
  return next.elements.flatMap(el => {
    const prior = before.get(el.id);
    if (!baseline.elements[el.id] || el.type !== 'text' || el.isDeleted || !prior || prior.isDeleted) return [];
    const oldText = typeof prior.originalText === 'string' ? prior.originalText : prior.text;
    const newText = typeof el.originalText === 'string' ? el.originalText : el.text;
    return typeof oldText === 'string' && typeof newText === 'string' && oldText !== newText
      ? [{ elementId: el.id, before: oldText, after: newText, rendered: typeof el.text === 'string' ? el.text : newText }] : [];
  });
}

/** Recover unsynchronized native label intent from durable companion + baseline. */
export function pendingLabelsFromArtifact(scene: NativeScene, baseline: GeneratedBaseline): LabelEdit[] {
  const previous: NativeScene = { elements: Object.entries(baseline.elements).map(([id, record]) => ({
    ...record.snapshot, id, type: String(record.snapshot.type), x: record.x, y: record.y, width: record.width, height: record.height,
  })) };
  return changedGeneratedLabels(previous, scene, baseline).filter(edit => isNodeLabel(edit, baseline));
}

function withLabel(source: string, id: string, label: string): string {
  const prefix = `${id}.label: `;
  // Only update our own exact scalar assignment. Arbitrary user syntax remains
  // byte-identical. The real compiler checks scope and effective meaning below.
  const lines = source.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith(prefix) || !line.endsWith(' # canvas-label')) continue;
    const value = line.slice(prefix.length, -' # canvas-label'.length);
    try {
      if (typeof JSON.parse(value) !== 'string') continue;
      lines[i] = `${prefix}${JSON.stringify(label)} # canvas-label`;
      return lines.join('\n');
    } catch { /* User changed the syntax; preserve it and append a new scalar. */ }
  }
  return `${source}${source.endsWith('\n') || !source ? '' : '\n'}${prefix}${JSON.stringify(label)} # canvas-label\n`;
}

function graphMeaning(diagram: D2Diagram, labels: Map<string, string> = new Map()): string {
  return JSON.stringify({
    shapes: (diagram.shapes ?? []).map(s => ({ id: s.id, type: s.type, label: labels.get(s.id) ?? s.label, columns: s.columns })),
    connections: (diagram.connections ?? []).map(c => ({ id: c.id, src: c.src, dst: c.dst, label: c.label, srcArrow: c.srcArrow, dstArrow: c.dstArrow })),
  });
}

/** Validate both the existing draft and proposed effective D2 graph before write-back. */
export async function synchronizeLabels(
  source: string,
  baseline: GeneratedBaseline,
  edits: readonly LabelEdit[],
  compile: (source: string) => Promise<D2Diagram>,
): Promise<LabelSyncResult> {
  if (!edits.length) return { source, baseline, error: null };
  try {
    const current = await compile(source);
    const labels = new Map<string, string>();
    let candidate = source;
    for (const edit of edits) {
      const shape = current.shapes?.find(s => `d2:${s.id}:label` === edit.elementId);
      if (!shape || /[\r\n]/.test(shape.id)) throw new Error(`Cannot map ${edit.elementId} to one node label. Edit its source, or undo the canvas text edit.`);
      if (shape.label !== edit.before && shape.label !== edit.after) throw new Error(`The source label for ${shape.id} changed too. Restore its previous label in Code or undo the canvas rename, then retry.`);
      labels.set(shape.id, edit.after);
      if (shape.label !== edit.after) candidate = withLabel(candidate, shape.id, edit.after);
    }
    const checked = candidate === source ? current : await compile(candidate);
    if (graphMeaning(checked) !== graphMeaning(current, labels)) throw new Error('D2 did not preserve node identities and unrelated labels. This source form needs a manual Code edit.');
    const elements = { ...baseline.elements };
    for (const edit of edits) {
      const base = elements[edit.elementId];
      if (base) elements[edit.elementId] = { ...base, snapshot: { ...base.snapshot, text: edit.rendered ?? edit.after, originalText: edit.after } };
    }
    // Keep generated geometry as the old merge base; only the synchronized
    // label content is now acknowledged. Re-layout still happens on Regenerate.
    return { source: candidate, baseline: { ...baseline, sourceHash: hashSource(candidate), elements }, error: null };
  } catch (error) {
    return { source, baseline, error: `Canvas label not synchronized: ${error instanceof Error ? error.message : String(error)}` };
  }
}
