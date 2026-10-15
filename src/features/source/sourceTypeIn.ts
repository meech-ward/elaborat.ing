import * as monaco from "monaco-editor";
import { writeInMs, writeInStops } from "../document/writeIn";
import "./sourceTypeIn.css";

/**
 * An agent's addition typing into Source, as a model streams an answer, as
 * the rendered note writes it in (src/preview/typeIn.ts): the text a newer
 * saved version added at the end of the note keeps its place from the start,
 * unseen, and shows a few characters at a time behind a blinking caret, at
 * the pace src/features/document/writeIn.ts sets. Decorations only
 * (sourceTypeIn.css), outside undo. The person's first key or click in the
 * editor shows the rest at once, and so does any change to the text. With
 * reduced motion nothing is written in.
 */
export type SourceTypeIn = {
  /** Where the writing is, as an offset in the model's text; null once it has finished. */
  readonly offset: number | null;
  /** Whether the person follows the writing, which then stays in view. */
  readonly following: boolean;
  /** Shows what is left at once. */
  finish(): void;
};

/**
 * Writes in the editor's text from `from` (an offset in the model) to its end.
 * With `follow`, the line it starts on comes into view near the top, as
 * Monaco's reveal near top puts it, and the writing stays in view as it goes
 * down, until the person scrolls up. Null when there is nothing to write in,
 * or the person prefers reduced motion.
 */
export function typeInSource(editor: monaco.editor.IStandaloneCodeEditor, from: number, follow: boolean): SourceTypeIn | null {
  const model = editor.getModel();
  if (!model || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const text = model.getValue();
  const units = text.length - from;
  if (units <= 0) return null;
  const stops = writeInStops(text.slice(from));
  const ms = writeInMs(units);
  const end = model.getPositionAt(text.length);
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
  const decorations = editor.createDecorationsCollection();
  const listeners: monaco.IDisposable[] = [];
  const began = performance.now();
  let written: number | null = null;
  let frame = 0;
  // Where the editor was last scrolled to, and the furthest it was sent.
  let scrolled = editor.getScrollTop();
  let target = scrolled;

  const finish = () => {
    if (written === null) return;
    written = null;
    cancelAnimationFrame(frame);
    for (const listener of listeners) listener.dispose();
    decorations.clear();
  };
  listeners.push(
    editor.onKeyDown(finish),
    editor.onMouseDown(finish),
    editor.onDidChangeModelContent(finish),
    editor.onDidScrollChange((event) => {
      if (event.scrollTop < scrolled - 1) follow = false;
      scrolled = event.scrollTop;
    }),
  );

  /**
   * Scroll down to `top`, smoothly: never back up, nor short of a scroll on
   * its way. Monaco animates a scroll only while smoothScrolling is on, which
   * would also animate the person's own scrolling, so it is on for this one.
   * (Its reveals of a position also scroll sideways when the view next
   * draws, which then stops a smooth scroll still on its way.)
   */
  const scrollDown = (top: number) => {
    const height = editor.getLayoutInfo().height;
    const to = Math.min(top, editor.getScrollHeight() - height);
    if (to <= Math.max(editor.getScrollTop(), target)) return;
    target = to;
    editor.updateOptions({ smoothScrolling: true });
    editor.setScrollTop(to, monaco.editor.ScrollType.Smooth);
    editor.updateOptions({ smoothScrolling: false });
  };
  /** The writing's line, with one to spare below it, when it goes below the bottom. */
  const keepInView = (at: monaco.Position) =>
    scrollDown(editor.getTopForPosition(at.lineNumber, at.column) + 2 * lineHeight - editor.getLayoutInfo().height);
  if (follow) {
    // Five lines or a fifth of the view above it, as Monaco's reveal near top leaves.
    const height = editor.getLayoutInfo().height;
    const first = model.getPositionAt(from);
    const top = editor.getTopForPosition(first.lineNumber, first.column);
    scrollDown(Math.max(top + lineHeight - height, top - Math.max(5 * lineHeight, height * 0.2)));
  }
  const show = (next: number) => {
    written = next;
    const at = model.getPositionAt(from + next);
    decorations.set([
      { range: monaco.Range.fromPositions(at, end), options: { inlineClassName: "source-unwritten" } },
      // The numbers of the lines it has not reached yet.
      ...(at.lineNumber < end.lineNumber
        ? [{ range: new monaco.Range(at.lineNumber + 1, 1, end.lineNumber, end.column), options: { lineNumberClassName: "source-unwritten-line" } }]
        : []),
      // A new caret each time it moves: it stays lit while writing.
      { range: monaco.Range.fromPositions(at), options: { beforeContentClassName: "source-writing-caret" } },
    ]);
    if (follow) keepInView(at);
  };
  const step = () => {
    if (written === null) return;
    const into = (units * (performance.now() - began)) / ms;
    if (into >= units) return finish();
    let next = 0;
    for (const stop of stops) {
      if (stop > into) break;
      next = stop;
    }
    if (next !== written) show(next);
    frame = requestAnimationFrame(step);
  };
  show(0);
  frame = requestAnimationFrame(step);
  return {
    get offset() {
      return written === null ? null : from + written;
    },
    get following() {
      return written !== null && follow;
    },
    finish,
  };
}
