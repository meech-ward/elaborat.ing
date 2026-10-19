import type { MarkType, Node as PMNode } from "prosemirror-model";
import { Mapping, Transform, type Step } from "prosemirror-transform";
import { fluidSchema } from "./fluidSchema";

/**
 * The nearest form Markdown can store (docs/architecture.md, Rendered
 * editing). An edit in a note's Rendered view is accepted when the document
 * its source change reads back as is the editor's own, or differs from it
 * only by whitespace Markdown cannot hold: `markdownForm` says exactly which.
 * The editor then takes the document the source makes in place of its own
 * (`changeTo`), and redoes on it the edits it made since (`rebaseSteps`).
 * The app and the frame both use this module.
 */

/** Formatting whose delimiters cannot have a space or tab just inside them. */
const DELIMITED: readonly MarkType[] = [
  fluidSchema.marks.em,
  fluidSchema.marks.strong,
  fluidSchema.marks.strike,
];

/**
 * `doc` as Markdown can hold it: spaces and tabs at the start or end of bold,
 * italics or strikethrough moved just outside them (`*a *b` holds as
 * `*a* b`), and none at the start of a paragraph or heading, where Markdown
 * drops them. Nothing else changes: the same blocks, every other character,
 * and the formatting on every other character. Its mapping says where each
 * position goes.
 */
export function markdownForm(doc: PMNode): Transform {
  const tr = new Transform(doc);
  const leading: Array<[number, number]> = [];
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    const start = pos + 1;
    // One character per position: an atom or a line break is not whitespace.
    const text = block.textBetween(0, block.content.size, undefined, "￼");
    for (const type of DELIMITED) {
      let from: number | null = null;
      const span = (to: number) => {
        const marked = text.slice(from!, to);
        const head = /^[ \t]*/.exec(marked)![0].length;
        const tail = head === marked.length ? 0 : /[ \t]*$/.exec(marked)![0].length;
        if (head) tr.removeMark(start + from!, start + from! + head, type);
        if (tail) tr.removeMark(start + to - tail, start + to, type);
        from = null;
      };
      block.forEach((child, offset) => {
        if (type.isInSet(child.marks)) from ??= offset;
        else if (from !== null) span(offset);
      });
      if (from !== null) span(block.content.size);
    }
    const lead = /^[ \t]*/.exec(text)![0].length;
    if (lead) leading.push([start, start + lead]);
    return false;
  });
  // Marks move no position; take the spaces out from the end, so each range still holds.
  for (const [from, to] of leading.reverse()) tr.delete(from, to);
  return tr;
}

/** Whether two documents differ only by whitespace Markdown cannot hold. */
export function sameMarkdownForm(a: PMNode, b: PMNode): boolean {
  return a.eq(b) || markdownForm(a).doc.eq(markdownForm(b).doc);
}

/**
 * A change from `from` to `to` whose mapping says where each position in
 * `from` goes: Markdown's form of `from` when that is `to`, so only the
 * whitespace it drops moves, else one replacement of the stretch where the
 * two differ.
 */
export function changeTo(from: PMNode, to: PMNode): Transform {
  const form = markdownForm(from);
  if (form.doc.eq(to)) return form;
  const tr = new Transform(from);
  const start = from.content.findDiffStart(to.content);
  if (start === null) return tr;
  let { a, b } = from.content.findDiffEnd(to.content)!;
  // Text taken out or added beside text just like it: the stretch starts at the first difference.
  const overlap = start - Math.min(a, b);
  if (overlap > 0) {
    a += overlap;
    b += overlap;
  }
  tr.replace(start, a, to.slice(start, b));
  return tr.doc.eq(to) ? tr : new Transform(from).replaceWith(0, from.content.size, to.content);
}

/**
 * Steps made one after another from `from`, redone one after another from
 * `to` (what `from` became through a change they did not make), each mapped
 * through that change, as prosemirror-collab rebases unconfirmed steps.
 * `docs[i]` is the document the first `i` redone steps make, and
 * `mapping(i)` maps a position in the one the first `i` steps made from
 * `from` to it. Null when a step no longer applies.
 */
export function rebaseSteps(
  steps: readonly Step[],
  from: PMNode,
  to: PMNode,
): { steps: Step[]; docs: PMNode[]; mapping: (i: number) => Mapping } | null {
  const count = steps.length;
  // Back through the steps, newest first, then through the change, then forward through each redone step.
  const mapping = new Mapping();
  for (let i = count - 1; i >= 0; i--) mapping.appendMap(steps[i].getMap().invert());
  mapping.appendMapping(changeTo(from, to).mapping);
  const changed = mapping.maps.length;
  const redone: Step[] = [];
  const docs = [to];
  for (let i = 0; i < count; i++) {
    const step = steps[i].map(mapping.slice(count - i));
    const doc = step?.apply(docs[i]).doc;
    if (!step || !doc) return null;
    // The redone step mirrors the one undone, so a position in what it typed comes back to its place.
    mapping.appendMap(step.getMap(), count - 1 - i);
    redone.push(step);
    docs.push(doc);
  }
  return { steps: redone, docs, mapping: (i) => mapping.slice(count - i, changed + i) };
}
