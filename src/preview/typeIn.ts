/**
 * An agent's addition typing into the rendered note, as a model streams an
 * answer. The blocks a newer saved version added at the end of the note
 * (`fluid.writeIn`) take their place at once, unseen, and their text shows a
 * few characters at a time behind a blinking caret (the chat card's, from
 * src/chat-card/live/mount.ts), at the pace src/features/document/writeIn.ts
 * sets. A code block, an embed or any other island, and a rule, fades in when
 * the writing reaches it. Nothing moves: what is not written yet keeps its
 * layout and is only hidden (fluid.css).
 *
 * Decorations only (`typeInPlugin`): the document, the selection and the
 * note's history stay as they are, and nothing reaches the parent. The
 * person's first key or pointer in the frame shows the rest at once, and so
 * does any other document taking its place. With reduced motion nothing is
 * written in. The preview frame's own (preview-entry.tsx).
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { writeInMs, writeInStops } from "../features/document/writeIn";

/** How many characters' time an island or a rule takes when the writing reaches it, while it fades in. */
const BLOCK_UNITS = 24;

const typeInKey = new PluginKey<DecorationSet>("type-in");

/** The editor's part: what a writing-in hides and shows. An edit ends it. */
export const typeInPlugin = new Plugin<DecorationSet>({
  key: typeInKey,
  state: {
    init: () => DecorationSet.empty,
    apply: (tr, shown) => (tr.getMeta(typeInKey) as DecorationSet | undefined) ?? (tr.docChanged ? DecorationSet.empty : shown),
  },
  props: { decorations: (state) => typeInKey.getState(state) },
});

/**
 * One stretch the writing goes through, in order: a block's text from `from`
 * (`stops`: where in it the writing may pause), or a block that comes in
 * whole (an island or a rule, `stops` null). `units`: its characters, or the
 * time a whole block takes.
 */
type Stretch = { pos: number; from: number; units: number; stops: number[] | null };

/** Every leaf in a block's text counts one character, as it takes one position. */
const leafText = (leaf: PMNode) => (leaf.type.name === "hard_break" ? "\n" : "￼");

function stretchesFrom(doc: PMNode, start: number): Stretch[] {
  const stretches: Stretch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isBlock || pos + node.nodeSize <= start) return false;
    if (node.isTextblock) {
      const from = Math.max(pos + 1, start);
      const text = node.textBetween(from - pos - 1, node.content.size, "\n", leafText);
      if (text) stretches.push({ pos, from, units: text.length, stops: writeInStops(text) });
      return false;
    }
    if (node.isAtom) {
      if (pos >= start) stretches.push({ pos, from: pos, units: BLOCK_UNITS, stops: null });
      return false;
    }
    return true;
  });
  return stretches;
}

/** Where the writing is `units` characters' time in: the stretch, and how much of its text is written (at its last stop passed). */
type Place = { index: number; written: number };
function placeAt(stretches: Stretch[], units: number): Place {
  let start = 0;
  for (let index = 0; index < stretches.length; index++) {
    const { units: length, stops } = stretches[index];
    if (units < start + length) {
      let written = 0;
      for (const stop of stops ?? []) {
        if (stop > units - start) break;
        written = stop;
      }
      return { index, written };
    }
    start += length;
  }
  return { index: stretches.length, written: 0 };
}

function caret(): HTMLElement {
  const element = document.createElement("span");
  element.className = "type-in-caret";
  element.setAttribute("aria-hidden", "true");
  return element;
}

/**
 * What the note shows at `place`: the blocks brought in whole so far fading
 * in, the rest of the text being written hidden after a caret, and every
 * block the writing has not reached hidden (its outermost block, so a list
 * shows its new items as the writing gets to them). Inline code with nothing
 * written yet hides its box too.
 */
function decorationsAt(doc: PMNode, stretches: Stretch[], { index, written }: Place): DecorationSet {
  const decorations: Decoration[] = [];
  for (const stretch of stretches.slice(0, index + 1))
    if (!stretch.stops) decorations.push(Decoration.node(stretch.pos, stretch.pos + doc.nodeAt(stretch.pos)!.nodeSize, { class: "type-in-arrived" }));
  const current = stretches[index];
  if (current.stops) {
    const at = current.from + written;
    const block = doc.nodeAt(current.pos)!;
    block.forEach((child, offset) => {
      const from = current.pos + 1 + offset;
      const to = from + child.nodeSize;
      if (to <= at) return;
      const whole = from >= at && child.marks.some((mark) => mark.type.spec.code);
      decorations.push(Decoration.inline(Math.max(from, at), to, { class: whole ? "type-in-hidden type-in-hidden-code" : "type-in-hidden" }));
    });
    // A new caret each time it moves: it stays lit while writing, and blinks when the writing pauses.
    decorations.push(Decoration.widget(at, caret, { side: -1, key: `type-in-caret:${at}` }));
  }
  doc.descendants((node, pos) => {
    if (!node.isBlock || pos + node.nodeSize <= current.pos) return false;
    if (pos > current.pos) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "type-in-unwritten" }));
      return false;
    }
    return pos < current.pos;
  });
  return DecorationSet.create(doc, decorations);
}

export type TypeIn = {
  /** Where the writing is, in the document it writes into; null once it has finished. */
  readonly position: number | null;
  /** Shows what is left at once. */
  finish(): void;
};

/**
 * Writes in what the document on screen has from `start` (a position) on,
 * once its view has the plugin. `follow` runs after each step, with the
 * element where the writing is (its caret, or a block coming in). Null when
 * there is nothing to write in, or the person prefers reduced motion.
 */
export function typeIn(view: EditorView, start: number, follow?: (at: Element) => void): TypeIn | null {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const { doc } = view.state;
  const stretches = stretchesFrom(doc, start);
  const units = stretches.reduce((sum, stretch) => sum + stretch.units, 0);
  if (units === 0) return null;
  const ms = writeInMs(units);
  const began = performance.now();
  let place: Place | null = null;
  let frame = 0;

  const finish = () => {
    if (!place) return;
    place = null;
    cancelAnimationFrame(frame);
    window.removeEventListener("keydown", finish, true);
    window.removeEventListener("pointerdown", finish, true);
    // Another document in its place (or an edit) took the decorations with it.
    if (view.state.doc === doc) view.dispatch(view.state.tr.setMeta(typeInKey, DecorationSet.empty));
  };
  const show = (next: Place) => {
    place = next;
    view.dispatch(view.state.tr.setMeta(typeInKey, decorationsAt(doc, stretches, next)));
    const at = view.dom.querySelector(".type-in-caret") ?? view.nodeDOM(stretches[next.index].pos);
    if (follow && at instanceof Element) follow(at);
  };
  const step = () => {
    if (!place) return;
    if (view.state.doc !== doc) return finish();
    const next = placeAt(stretches, (units * (performance.now() - began)) / ms);
    if (next.index >= stretches.length) return finish();
    if (next.index !== place.index || next.written !== place.written) show(next);
    frame = requestAnimationFrame(step);
  };
  // Hidden before the frame paints, then written in frame by frame.
  show(placeAt(stretches, 0));
  window.addEventListener("keydown", finish, true);
  window.addEventListener("pointerdown", finish, true);
  frame = requestAnimationFrame(step);
  return {
    get position() {
      if (!place) return null;
      const stretch = stretches[place.index];
      return stretch.from + place.written;
    },
    finish,
  };
}
