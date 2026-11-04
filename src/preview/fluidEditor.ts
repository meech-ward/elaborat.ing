import {
  AllSelection,
  EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
  type Command,
} from "prosemirror-state";
import { Decoration, DecorationSet, EditorView, type NodeView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import {
  baseKeymap,
  chainCommands,
  setBlockType,
  toggleMark,
  wrapIn,
} from "prosemirror-commands";
import {
  splitListItem,
  sinkListItem,
  wrapInList,
} from "prosemirror-schema-list";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { ReplaceStep, Step, type Mapping } from "prosemirror-transform";
import { fluidSchema } from "../features/rendered/fluidSchema";
import {
  afterHeldBreak,
  codeFenceOpener,
  emptyListBackspace,
  hardBreak,
  leftBreak,
  liftItem,
  listItemBackspace,
  listItemDelete,
  keepingEmptyParagraphs,
  quoteStartEnter,
  toggleTask,
  trailingBreak,
  typedTogether,
} from "../features/rendered/fluidCommands";
import { changeTo, rebaseSteps } from "../features/rendered/nearestForm";
import type {
  RenderMessage,
  FluidSyntaxHint,
} from "../features/rendered/protocol";
import { blockShape, isStructuralHistoryBoundary } from "../features/source/renderedHistory";
import { isReadOnly } from "./readOnly";

type Selection = { anchor: number; head: number };
type Operation = {
  steps: ReturnType<Transaction["steps"][number]["toJSON"]>[];
  before: Selection;
  after: Selection;
  group: string;
  syntax?: FluidSyntaxHint;
  /** The document the edit made here. Never sent. */
  doc: PMNode;
};
const selectionOf = (state: EditorState): Selection => ({
  anchor: state.selection.anchor,
  head: state.selection.head,
});
/**
 * A line break typed at the end of a paragraph (`hardBreak`), with whatever
 * it replaced: `step`, made from `base`. Markdown cannot write a break there,
 * so the editor shows it (in `doc`) but sends nothing until text is typed
 * after it, then sends the break and the text as one step. Anything else
 * takes it out again, and the parent never hears of it.
 */
type HeldBreak = { step: ReplaceStep; base: PMNode; doc: PMNode; before: Selection };
/** Keys that move the caret or split text: they take a held break out first. */
const LEAVING_KEYS = new Set(["Enter", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
/** Keys whose move, from the line a held break made, ends where taking the break out leaves the caret. */
const BACK_KEYS = new Set(["ArrowLeft", "ArrowUp"]);
/** The caret where a held break (the step that puts it in) goes. */
const atBreak = (step: ReplaceStep): Selection => ({ anchor: step.from, head: step.from });
/** Where the caret is just after a held break. */
const afterBreak = (step: ReplaceStep) => step.from + step.slice.size;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);
const shapes = new WeakMap<PMNode, string>();
/** `blockShape`, once per document. */
function shapeOf(doc: PMNode): string {
  let shape = shapes.get(doc);
  if (shape === undefined) shapes.set(doc, (shape = blockShape(doc)));
  return shape;
}
const mapSelection = ({ anchor, head }: Selection, mapping: Mapping): Selection => ({
  anchor: mapping.map(anchor),
  head: mapping.map(head),
});
/** A DOM node in the editable document, outside any object island. */
function inProse(view: EditorView, node: Node): boolean {
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return (
    !!element &&
    view.dom.contains(element) &&
    !element.closest("[data-fluid-object]")
  );
}

/**
 * Chromium reports a caret moved by a native key (an arrow, Home, End) with a
 * `selectionchange` event that can arrive after the next keydown, and
 * ProseMirror updates its selection only from that event. A key command run
 * in between, such as Enter's split, would act where the caret was before.
 * So take the browser's caret first. A click is reported the same way, and
 * after a select-all (Mod-a) the next keys would replace the whole document,
 * which a note with computed output refuses, losing them: so a select-all is
 * taken over too. Untouched, it reads back from the page as itself. Node
 * selections, and carets in object islands, stay as ProseMirror has them.
 */
function adoptDOMCaret(view: EditorView) {
  const current = view.state.selection;
  const dom = view.dom.ownerDocument.getSelection();
  if (!(current instanceof TextSelection || current instanceof AllSelection) || !view.hasFocus() || !dom) return;
  const { anchorNode, focusNode } = dom;
  if (!anchorNode || !focusNode) return;
  if (!inProse(view, anchorNode) || !inProse(view, focusNode)) return;
  const anchor = view.posAtDOM(anchorNode, dom.anchorOffset);
  const head = view.posAtDOM(focusNode, dom.focusOffset);
  if (anchor === current.anchor && head === current.head) return;
  const { doc } = view.state;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.between(doc.resolve(anchor), doc.resolve(head)),
    ),
  );
}

/**
 * ProseMirror's own focus handler runs straight after `handleDOMEvents.focus`
 * and sets a 20 ms timer that writes ProseMirror's selection back to the DOM
 * if the DOM caret moved without ProseMirror seeing it. A key pressed in those
 * 20 ms has moved the caret without ProseMirror seeing it yet (see
 * `adoptDOMCaret`), so the timer would undo the move. ProseMirror has no
 * option for this, so wrap the next timer set during this focus event and run
 * `first` at the start of its callback, in the same task: key events can run
 * between two separate timers.
 *
 * The check is skipped when the document has no selection to write to. In
 * Firefox a hidden frame has none (`getSelection()` is null) and ProseMirror
 * would throw, which the frame reports as a failed preview. Clicking a link
 * that opens a file in another tab focuses the editor and hides its frame,
 * and the timer can run after the frame is hidden.
 */
function beforeFocusCheck(first: () => void) {
  const setTimer = window.setTimeout;
  const restore = () => {
    window.setTimeout = setTimer;
  };
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) => {
    restore();
    if (typeof handler !== "function") return setTimer(handler, timeout, ...rest);
    return setTimer(
      (...args: unknown[]) => {
        first();
        if (document.getSelection()) handler(...args);
      },
      timeout,
      ...rest,
    );
  }) as typeof window.setTimeout;
  // Also restore if this focus event sets no timer.
  queueMicrotask(restore);
}

/** Commented text to mark, as document ranges; `active` is the thread open in the panel. */
export type CommentMarkRange = { id: string; from: number; to: number; active: boolean };

type Flash = { from: number; to: number };
type CommentMarksState = { marks: CommentMarkRange[]; flash: Flash | null; set: DecorationSet };
type CommentMarksMeta = { marks?: CommentMarkRange[]; flash?: Flash | null };
const commentMarksKey = new PluginKey<CommentMarksState>("comment-marks");

/**
 * Marks commented text with the app's highlight classes (the library's
 * commentHighlight.css, which the frame's stylesheet imports). The marks move
 * with edits until the next set arrives; each carries its thread's id, so a
 * click on it can open the thread. `flash` is text being shown from the
 * panel, marked as the open thread's and flashed once.
 */
function commentMarksPlugin() {
  const clamp = (doc: PMNode, position: number) => Math.max(0, Math.min(position, doc.content.size));
  const decorate = (doc: PMNode, marks: CommentMarkRange[], flash: Flash | null) =>
    DecorationSet.create(doc, [
      ...marks.flatMap((mark) => {
        const from = clamp(doc, mark.from);
        const to = clamp(doc, mark.to);
        if (from >= to) return [];
        const classes = mark.active ? "comment-highlight comment-highlight-active" : "comment-highlight";
        return [Decoration.inline(from, to, { class: classes, "data-comment-thread": mark.id })];
      }),
      ...(flash && clamp(doc, flash.from) < clamp(doc, flash.to)
        ? [Decoration.inline(clamp(doc, flash.from), clamp(doc, flash.to), { class: "comment-highlight comment-highlight-active comment-highlight-flash" })]
        : []),
    ]);
  return new Plugin<CommentMarksState>({
    key: commentMarksKey,
    state: {
      init: () => ({ marks: [], flash: null, set: DecorationSet.empty }),
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(commentMarksKey) as CommentMarksMeta | undefined;
        let { marks, flash } = value;
        if (tr.docChanged) {
          marks = marks.map((mark) => ({ ...mark, from: tr.mapping.map(mark.from, 1), to: tr.mapping.map(mark.to, -1) }));
          if (flash) flash = { from: tr.mapping.map(flash.from, 1), to: tr.mapping.map(flash.to, -1) };
        }
        if (!meta && !tr.docChanged) return value;
        if (meta?.marks) marks = meta.marks;
        if (meta && "flash" in meta) flash = meta.flash ?? null;
        return { marks, flash, set: decorate(state.doc, marks, flash) };
      },
    },
    props: { decorations: (state) => commentMarksKey.getState(state)?.set },
  });
}

/**
 * A list item. A task item ("- [ ] step") shows its box, the library's task
 * box (taskList.css), named by the item's text. Ticking it while the note
 * can be edited sets the item's `checked`, an edit like any other, which the
 * parent writes as `[x]` or `[ ]` in the source.
 */
function listItemView(
  node: PMNode,
  view: EditorView,
  getPos: () => number | undefined,
  history: (direction: "undo" | "redo") => void,
): NodeView {
  const dom = document.createElement("li");
  if (node.attrs.checked === null)
    return { dom, contentDOM: dom, update: (next) => next.type === node.type && next.attrs.checked === null };
  dom.className = "task-list-item";
  // A label, so the space around the box ticks it too.
  const holder = document.createElement("label");
  holder.className = "task-list-box";
  holder.contentEditable = "false";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "task-list-check";
  holder.append(box);
  const contentDOM = document.createElement("div");
  contentDOM.className = "task-list-text";
  dom.append(holder, contentDOM);
  let current = node;
  const show = () => {
    box.checked = current.attrs.checked === true;
    box.disabled = !view.editable;
    box.setAttribute("aria-label", current.firstChild?.textContent.trim() || "Task");
  };
  show();
  box.addEventListener("change", () => {
    const pos = getPos();
    if (!view.editable || pos === undefined) return show();
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, checked: box.checked }));
  });
  // Undo and redo work from the box as from the text.
  box.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (!(event.ctrlKey || event.metaKey) || (key !== "z" && key !== "y")) return;
    event.preventDefault();
    history(key === "z" && !event.shiftKey ? "undo" : "redo");
  });
  return {
    dom,
    contentDOM,
    update: (next) => {
      if (next.type !== node.type || next.attrs.checked === null) return false;
      current = next;
      show();
      return true;
    },
    stopEvent: (event) => event.target instanceof Node && holder.contains(event.target),
    ignoreMutation: (mutation) => holder.contains(mutation.target),
  };
}

function objects(doc: PMNode): string {
  const ids: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "object" || node.type.name === "inline_object")
      ids.push(node.attrs.id);
  });
  return JSON.stringify(ids);
}

/** One persistent source-derived view. No history plugin, serializer, or IO. */
export class FluidEditor {
  readonly view: EditorView;
  readonly islands = new Map<string, HTMLElement>();
  private session = "";
  private revision = 0;
  private epoch = -1;
  private operation = 0;
  private inFlight = false;
  /** The document the edit in flight made here. */
  private sent: PMNode | null = null;
  private queue: Operation[] = [];
  private group = 0;
  private lastInput = 0;
  private historyPending: "undo" | "redo" | null = null;
  private keysSinceFocus = false;
  /** Until when Tab and Shift+Tab leave the text, after Escape (see `indenting`). */
  private tabLeaves = 0;
  private held: HeldBreak | null = null;
  private flashTimer = 0;
  /**
   * A typed code fence opening the parent is making a code block of (`pos`
   * is its paragraph). Until the new document arrives, typed text is kept
   * here for the code block instead of going into the paragraph.
   */
  private fence: { pos: number; sent: boolean; typed: string } | null = null;
  private fenceTyped = "";
  private notifyIslands: () => void;
  private send: (message: object) => void;

  /**
   * `send` delivers the editor's messages to whatever checks its edits: the
   * parent page over the frame's port, or a checker in the same page (the
   * chat card). With `codeFences`, Enter after a typed fence opening (```js)
   * asks for a code block; the chat card's code blocks are not editable, so
   * it has none. `plugins` join the view's own, such as the preview frame's
   * type-in (typeIn.ts).
   */
  constructor(
    mount: HTMLElement,
    notifyIslands: () => void,
    send: (message: object) => void,
    { codeFences = false, plugins = [] }: { codeFences?: boolean; plugins?: readonly Plugin[] } = {},
  ) {
    this.notifyIslands = notifyIslands;
    this.send = send;
    const requestHistory =
      (direction: "undo" | "redo"): Command =>
      () => {
        this.history(direction);
        return true;
      };
    const nodes = fluidSchema.nodes;
    // Tab and Shift+Tab move a list item in and out a level, and otherwise
    // do nothing: the keyboard stays in the text, where taking it away would
    // lose what is typed next. Escape, then Tab or Shift+Tab, takes it out as
    // the browser would (CodeMirror's convention), so it is never trapped.
    // From a control inside the note (a table's scroll region), Tab moves on.
    const indenting =
      (command: Command): Command =>
      (state, dispatch, view) => {
        if (performance.now() < this.tabLeaves || !view?.hasFocus()) return false;
        command(state, dispatch, view);
        return true;
      };
    this.view = new EditorView(mount, {
      state: EditorState.create({
        schema: fluidSchema,
        plugins: [
          commentMarksPlugin(),
          ...plugins,
          keymap({
            "Mod-z": requestHistory("undo"),
            "Mod-Shift-z": requestHistory("redo"),
            "Mod-y": requestHistory("redo"),
            "Mod-b": toggleMark(fluidSchema.marks.strong),
            "Mod-i": toggleMark(fluidSchema.marks.em),
            "Mod-`": toggleMark(fluidSchema.marks.code),
            Enter: keepingEmptyParagraphs(chainCommands(
              (state) => {
                const { $from, empty } = state.selection;
                if (
                  !codeFences ||
                  !empty ||
                  $from.depth !== 1 ||
                  $from.parentOffset !== $from.parent.content.size ||
                  !codeFenceOpener($from.parent)
                )
                  return false;
                this.fence = { pos: $from.before(), sent: false, typed: "" };
                this.group++;
                this.flush();
                return true;
              },
              (state, dispatch) => {
                const { $from, empty } = state.selection;
                if (
                  !empty ||
                  $from.parent.type !== nodes.paragraph ||
                  $from.parent.textContent !== "---"
                )
                  return false;
                if (dispatch) {
                  const from = $from.before(),
                    tr = state.tr.replaceWith(
                      from,
                      $from.after(),
                      Fragment.fromArray([
                        nodes.horizontal_rule.create(),
                        nodes.paragraph.create(),
                      ]),
                    );
                  dispatch(
                    tr.setSelection(
                      TextSelection.near(tr.doc.resolve(from + 2)),
                    ),
                  );
                }
                return true;
              },
              // Enter at the start of a heading puts an empty paragraph above
              // it and keeps the caret in the heading, as Enter at the start
              // of a paragraph does: one new block, written as blank lines,
              // where splitting would leave an empty heading to change back.
              (state, dispatch) => {
                const { $from, empty } = state.selection;
                if (
                  !empty ||
                  $from.depth !== 1 ||
                  $from.parentOffset !== 0 ||
                  $from.parent.type !== nodes.heading ||
                  !$from.parent.content.size
                )
                  return false;
                dispatch?.(state.tr.insert($from.before(), nodes.paragraph.create()).scrollIntoView());
                return true;
              },
              quoteStartEnter,
              // A new item after a task item is a task too, not yet ticked.
              (state, dispatch) => {
                const { $from } = state.selection;
                const task = $from.depth > 1 && $from.node(-1).attrs.checked != null;
                return splitListItem(nodes.list_item, task ? { checked: false } : undefined)(state, dispatch);
              },
              baseKeymap.Enter,
            )),
            Tab: indenting(sinkListItem(nodes.list_item)),
            "Shift-Tab": indenting(liftItem),
            "Shift-Enter": hardBreak,
            ...Object.fromEntries(
              Object.entries(baseKeymap).filter(([key]) => key !== "Enter"),
            ),
            Backspace: chainCommands(emptyListBackspace, listItemBackspace, baseKeymap.Backspace),
            Delete: chainCommands(listItemDelete, baseKeymap.Delete),
            "Mod-Enter": chainCommands(toggleTask, baseKeymap["Mod-Enter"]),
          }),
        ],
      }),
      // A read-only document (see readOnly.ts) is shown but cannot be edited.
      editable: () => !isReadOnly(),
      attributes: () => ({
        class: "reading-document preview-prose prose max-w-none",
        role: "textbox",
        "aria-label": "Rendered document",
        "aria-multiline": "true",
        ...(isReadOnly() ? { "aria-readonly": "true" } : {}),
      }),
      nodeViews: {
        object: (node) => this.objectView(node, false),
        inline_object: (node) => this.objectView(node, true),
        list_item: (node, view, getPos) =>
          listItemView(node, view, getPos, (direction) => this.history(direction)),
      },
      // Runs before the keymap, so every key command sees the real caret.
      handleKeyDown: (view, event) => {
        if (this.fence) {
          // The code block is on its way: Enter and Backspace act on the
          // text kept for it, and no other key edits the paragraph.
          if (event.key === "Enter") this.fence.typed += "\n";
          else if (event.key === "Backspace")
            this.fence.typed = this.fence.typed.slice(0, -1);
          else if (!["Delete", "Tab"].includes(event.key) && !event.ctrlKey && !event.metaKey)
            return false;
          return true;
        }
        this.keysSinceFocus = true;
        adoptDOMCaret(view);
        if (event.key === "Escape") this.tabLeaves = performance.now() + 2000;
        else if (event.key !== "Tab" && !MODIFIER_KEYS.has(event.key)) this.tabLeaves = 0;
        const held = this.heldBreak();
        if (held) {
          const { selection } = view.state;
          const after = selection.empty && selection.head === afterBreak(held.step);
          // Backspace just after a held break takes it out, as it would a
          // sent one. Keys that move the caret or split text take it out,
          // then act as usual, except a move back: taking the break out has
          // already put the caret at the end of the line above.
          if (event.key === "Backspace" && after) {
            this.dropBreak();
            return true;
          }
          if (LEAVING_KEYS.has(event.key) && !(event.key === "Enter" && event.shiftKey)) {
            this.dropBreak();
            return after && BACK_KEYS.has(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey;
          }
        }
        return false;
      },
      handleDOMEvents: {
        focus: (view) => {
          this.keysSinceFocus = false;
          beforeFocusCheck(() => {
            if (this.keysSinceFocus) adoptDOMCaret(view);
          });
          return false;
        },
        pointerdown: (view, event) => {
          // A touch scroll start must not force focus. Completed taps get
          // the fallback below, after the browser places the DOM caret.
          // Firefox's first click in an opaque frame can set a DOM caret
          // while leaving BODY active. Focus the one host for non-touch
          // pointers, then let the trusted pointer default place/extend
          // the actual selection. Code has its own native selection inside
          // an object island; focusing prose would restore its old caret.
          // A click after Escape puts Tab back to moving items.
          this.tabLeaves = 0;
          if (event.pointerType === "touch") return false;
          if (
            !(event.target instanceof Element) ||
            !event.target.closest(
              "button,input,select,textarea,[data-authoring-from],.task-list-box,.document-code",
            )
          )
            view.focus();
          return false;
        },
        click: (view, event) => {
          // Firefox can place the tapped caret in an opaque frame while
          // leaving BODY active. Focus the DOM host only: view.focus()
          // would overwrite that caret with the previous PM selection.
          // A scroll does not produce this completed click.
          if (
            !view.hasFocus() &&
            (!(event.target instanceof Element) ||
              !event.target.closest(
                "button,input,select,textarea,[data-authoring-from],.task-list-box,.document-code",
              ))
          )
            view.dom.focus({ preventScroll: true });
          return false;
        },
        blur: () => {
          this.group++;
          this.tabLeaves = 0;
          this.dropBreak();
          return false;
        },
      },
      handleTextInput: (view, from, to, text) => {
        if (this.fence) {
          this.fence.typed += text;
          return true;
        }
        // The finite structural Markdown shortcuts work through ordinary PM
        // transactions and the same checked source adapter, not a serializer.
        if (view.composing || from !== to) return false;
        const at = view.state.doc.resolve(from);
        if (at.marks().some((mark) => mark.type === fluidSchema.marks.code))
          return false;
        // A line break or an inline island counts one character, as it takes one position.
        const prefix = at.parent.textBetween(0, at.parentOffset, undefined, "\n");
        const marked = prefix + text;
        for (const [delimiter, name] of [
          ["**", "strong"],
          ["__", "strong"],
          ["~~", "strike"],
          ["`", "code"],
          ["*", "em"],
          ["_", "em"],
        ]) {
          if (
            name !== "code" &&
            (prefix.match(/(?<!\\)`/g)?.length ?? 0) % 2 === 1
          )
            continue;
          if (!marked.endsWith(delimiter)) continue;
          const start = marked.lastIndexOf(
            delimiter,
            marked.length - delimiter.length - 1,
          );
          if (
            start < 0 ||
            (delimiter.length === 1 && marked[start - 1] === delimiter)
          )
            continue;
          const value = marked.slice(
            start + delimiter.length,
            -delimiter.length,
          );
          if (!value || /^\s|\s$|\n/.test(value) || value.includes(delimiter))
            continue;
          const begin = at.start() + start;
          const tr = view.state.tr.insertText(text, from, to);
          if (marked[start - 1] === "\\") {
            this.dispatch(tr.delete(begin - 1, begin));
            return true;
          }
          tr.delete(
            begin + delimiter.length + value.length,
            begin + 2 * delimiter.length + value.length,
          );
          tr.delete(begin, begin + delimiter.length);
          tr.addMark(
            begin,
            begin + value.length,
            fluidSchema.marks[name].create(),
          );
          if (name === "strong" || name === "em")
            tr.setMeta("fluidSyntax", { delimiter });
          tr.removeStoredMark(fluidSchema.marks[name]);
          this.dispatch(tr);
          return true;
        }
        // `[ ]` or `[x]` typed at the start of a list item gives it a task
        // box: "]" in an empty item, or a space before the item's text.
        const item = at.depth > 1 ? at.node(-1) : null;
        const box = /^\[([ xX])(\]?)$/.exec(prefix);
        if (
          box &&
          item?.type === nodes.list_item &&
          item.attrs.checked === null &&
          at.index(-1) === 0 &&
          at.parent.type === nodes.paragraph
        ) {
          const rest = at.parent.textBetween(at.parentOffset, at.parent.content.size);
          const closed = !box[2] && text === "]" && !rest;
          const spaced = !!box[2] && text === " " && !!rest.trim();
          if (closed || spaced) {
            const tr = view.state.tr.delete(from - prefix.length, from);
            tr.setNodeMarkup(at.before(-1), undefined, { ...item.attrs, checked: box[1] !== " " });
            this.dispatch(tr);
            return true;
          }
        }
        if (text !== " " || at.parent.type !== nodes.paragraph) return false;
        let command: Command | null = null;
        if (/^#{1,6}$/.test(prefix))
          command = setBlockType(nodes.heading, { level: prefix.length });
        else if (/^[-*+]$/.test(prefix))
          command = wrapInList(nodes.bullet_list);
        else if (/^\d+\.$/.test(prefix))
          command = wrapInList(nodes.ordered_list, {
            order: Number(prefix.slice(0, -1)),
          });
        else if (prefix === ">") command = wrapIn(nodes.blockquote);
        if (!command) return false;
        const deletion = view.state.tr.delete(from - prefix.length, from);
        if (/^[-*+]$/.test(prefix))
          deletion.setMeta("fluidSyntax", { marker: prefix });
        const interim = view.state.apply(deletion);
        return command(interim, (next) => {
          for (const step of next.steps) deletion.step(step);
          deletion.setSelection(
            TextSelection.near(deletion.doc.resolve(next.selection.head)),
          );
          this.dispatch(deletion);
        });
      },
      dispatchTransaction: (tr) => this.dispatch(tr),
    });
    // In Firefox a frame its page hides (another tab, or Source) has no
    // selection: `getSelection()` is null there. ProseMirror writes its
    // selection to the page on every update while the editor has focus, and
    // would throw on null, which the frame reports as a failed preview. A
    // tab switch can hide the frame with the editor focused, and a newer
    // saved version (an agent's) can then arrive, keep the person's caret
    // and write in. Without a selection the editor counts as unfocused, so
    // an update leaves the page's selection alone until the frame shows.
    const hasFocus = this.view.hasFocus.bind(this.view);
    this.view.hasFocus = () => this.view.dom.ownerDocument.getSelection() !== null && hasFocus();
  }

  private post(message: object) {
    this.send({ session: this.session, revision: this.revision, ...message });
  }

  private objectView(node: PMNode, inline: boolean): NodeView {
    const id: string = node.attrs.id;
    const dom = document.createElement(inline ? "span" : "div");
    dom.contentEditable = "false";
    dom.dataset.fluidObject = id;
    this.islands.set(id, dom);
    queueMicrotask(this.notifyIslands);
    return {
      dom,
      update: (next) => next.type === node.type && next.attrs.id === id,
      stopEvent: (event) =>
        event.target instanceof Element &&
        !!event.target.closest(
          // Code is displayed inside an opaque object, not ProseMirror text.
          // Keep its native mouse/keyboard selection out of atom selection.
          "button,input,select,textarea,[data-authoring-from],.document-code",
        ),
      ignoreMutation: () => true,
      destroy: () => {
        if (this.islands.get(id) === dom) this.islands.delete(id);
        queueMicrotask(this.notifyIslands);
      },
    };
  }

  private dispatch(tr: Transaction) {
    if (!tr.docChanged) {
      if (tr.selectionSet) this.group++;
      this.view.updateState(this.view.state.apply(tr));
      // A caret moved away from a held break takes the break out.
      const held = this.heldBreak();
      const { selection } = this.view.state;
      if (held && tr.selectionSet && !(selection.empty && selection.head === afterBreak(held.step)))
        this.dropBreak();
      return;
    }
    if (this.fence) {
      // Any other edit (a paste, an input method's) waits for the code block.
      this.view.updateState(this.view.state);
      return;
    }
    if (objects(tr.doc) !== objects(this.view.state.doc)) {
      // DOMObserver may already have seen a native browser mutation. Re-read
      // the unchanged state to restore the rejected DOM, including islands.
      this.view.updateState(this.view.state);
      this.post({
        kind: "edit-rejected",
        message:
          "This selection crosses computed output. Edit that object in Source; no source was changed.",
      });
      return;
    }
    if (this.queue.length >= 200) {
      this.view.updateState(this.view.state);
      this.post({
        kind: "edit-rejected",
        message:
          "Source is still accepting edits. Please wait before typing more.",
      });
      return;
    }
    let before = selectionOf(this.view.state);
    let steps: readonly Step[] = tr.steps;
    // A sent line break the edit leaves at the end of its paragraph: the
    // parent gets the edit without it, and the editor holds it while the
    // caret is just after it (`holds`).
    let left: ReturnType<typeof leftBreak> = null;
    let holds = false;
    const held = this.heldBreak();
    if (held) {
      const next = afterHeldBreak(held.step, tr.steps);
      if (next === "spaces") {
        // Markdown cannot write spaces at the start of a line.
        this.view.updateState(this.view.state);
        return;
      }
      if (next && trailingBreak([next], tr.doc, held.base)) {
        this.view.updateState(this.view.state.apply(tr));
        this.held = { ...held, step: next, doc: this.view.state.doc };
        return;
      }
      // Where the held break is once the edit is made.
      const $break = tr.doc.resolve(tr.mapping.map(afterBreak(held.step), -1));
      if (next) {
        // The break and the text typed after it, as one step.
        this.held = null;
        steps = [next];
        before = held.before;
      } else if ($break.nodeBefore?.type === fluidSchema.nodes.hard_break && $break.parentOffset < $break.parent.content.size) {
        // Text the edit brought after the break (Delete joins the next
        // line's): the break can be written with it, as one step.
        this.held = null;
        steps = changeTo(held.base, tr.doc).steps;
        before = held.before;
      } else {
        // Any other edit takes the break out first, and is made without it.
        const redone = this.withoutBreak(held, tr);
        if (!redone) return;
        tr = redone;
        steps = tr.steps;
        before = selectionOf(this.view.state);
      }
    } else {
      const step = trailingBreak(tr.steps, tr.doc, tr.before);
      if (step) {
        this.view.updateState(this.view.state.apply(tr));
        this.held = { step, base: tr.before, doc: this.view.state.doc, before };
        return;
      }
      left = leftBreak(tr.before, tr.doc);
      holds = left !== null && tr.selection.empty && tr.selection.head === afterBreak(left.hold);
      if (left && !left.steps.length) {
        this.view.updateState(this.view.state.apply(tr));
        if (holds) this.held = { step: left.hold, base: left.base, doc: this.view.state.doc, before: atBreak(left.hold) };
        else this.showBase(left);
        return;
      }
      if (left) steps = left.steps;
    }
    const now = performance.now();
    if (now - this.lastInput > 750 || tr.getMeta("uiEvent") === "paste")
      this.group++;
    this.lastInput = now;
    // Replacing a multi-paragraph selection starts a typing burst; its first
    // character must share the subsequent characters' one Monaco undo group.
    // Empty split/join and formatting commands remain explicit boundaries.
    const json = steps.map((step) => step.toJSON());
    const structural = isStructuralHistoryBoundary(
      shapeOf(this.view.state.doc),
      shapeOf(tr.doc),
      json,
    );
    if (structural) this.group++;
    this.view.updateState(this.view.state.apply(tr));
    if (left && !holds) this.showBase(left);
    // What the parent will have once this edit is written.
    const doc = left ? left.base : this.view.state.doc;
    const after = left && holds ? atBreak(left.hold) : selectionOf(this.view.state);
    if (left && holds) this.held = { step: left.hold, base: left.base, doc: this.view.state.doc, before: after };
    const group = `${this.epoch}:${this.group}`;
    const syntax: FluidSyntaxHint | undefined = tr.getMeta("fluidSyntax");
    // Typing while an earlier edit is being checked waits as one edit, so
    // the parent checks a burst once, not once a key. An edit already sent
    // is never changed: only the last one waiting is.
    const last = this.queue.at(-1);
    const merged =
      last && last.group === group && !structural && !last.syntax && !syntax
        ? typedTogether(last.steps.map((step) => Step.fromJSON(fluidSchema, step)), steps)
        : null;
    if (last && merged) {
      last.steps = [merged.toJSON()];
      last.after = after;
      last.doc = doc;
    } else this.queue.push({ steps: json, before, after, group, syntax, doc });
    if (!this.inFlight && this.queue.length === 1)
      this.post({ kind: "fluid-pending", pending: true });
    if (structural) this.group++;
    this.flush();
  }

  /** The held line break, while the document on screen still shows it. */
  private heldBreak(): HeldBreak | null {
    if (this.held && this.held.doc !== this.view.state.doc) this.held = null;
    return this.held;
  }

  /** Take the held line break out of the document on screen, and the spaces it replaced back. */
  private dropBreak() {
    const held = this.heldBreak();
    if (!held) return;
    this.held = null;
    const { state } = this.view;
    this.view.updateState(state.apply(state.tr.step(held.step.invert(held.base))));
  }

  /**
   * Take out of the document on screen the line break an edit left at the
   * end of its paragraph (`leftBreak`) with the caret away from it, where no
   * text typed can follow it: the screen shows what the note will have.
   */
  private showBase(left: NonNullable<ReturnType<typeof leftBreak>>) {
    const { state } = this.view;
    this.view.updateState(state.apply(state.tr.step(left.hold.invert(left.base))));
  }

  /** `tr`, made on the document showing the held break, made again without it; null when it cannot be. */
  private withoutBreak(held: HeldBreak, tr: Transaction): Transaction | null {
    this.dropBreak();
    const { state } = this.view;
    const redone = rebaseSteps(tr.steps, held.doc, state.doc);
    if (!redone) {
      this.view.updateState(state);
      return null;
    }
    const next = state.tr;
    for (const step of redone.steps) next.step(step);
    next.setSelection(tr.selection.map(next.doc, redone.mapping(redone.steps.length)));
    for (const key of ["uiEvent", "fluidSyntax"])
      if (tr.getMeta(key) !== undefined) next.setMeta(key, tr.getMeta(key));
    return next;
  }

  private history(direction: "undo" | "redo") {
    // Undo takes a held line break out: the parent never had it.
    if (this.heldBreak()) {
      this.dropBreak();
      if (direction === "undo") return;
    }
    this.group++;
    this.historyPending = direction;
    this.flush();
  }

  /** Undo in the note's history, as Ctrl+Z in the prose does. */
  undo() {
    this.history("undo");
  }

  /**
   * The parent accepted the edit in flight in the nearest form Markdown can
   * store: `doc`, in place of `sent`, the document the edit made here
   * (src/features/rendered/nearestForm.ts). The editor takes it, with the
   * caret where it was, and redoes on it each edit made since, which the
   * parent has not been sent yet, so none is lost.
   */
  private takeNearest(doc: PMNode, sent: PMNode) {
    // The edits the parent has do not include a held line break: it goes on
    // the new document again, after the edits it has not been sent yet.
    const held = this.heldBreak();
    this.dropBreak();
    const { state } = this.view;
    const queued = this.queue.flatMap((op) => op.steps.map((json) => Step.fromJSON(fluidSchema, json)));
    const redone = rebaseSteps(queued, sent, doc);
    let next = doc;
    let mapping: Mapping;
    if (redone) {
      let at = 0;
      for (const op of this.queue) {
        const first = at;
        at += op.steps.length;
        op.steps = redone.steps.slice(first, at).map((step) => step.toJSON());
        op.before = mapSelection(op.before, redone.mapping(first));
        op.after = mapSelection(op.after, redone.mapping(at));
        op.doc = redone.docs[at];
      }
      next = redone.docs[at];
      mapping = redone.mapping(at);
    } else {
      // An edit made since no longer applies there (rare): the document alone is taken.
      this.queue = [];
      mapping = changeTo(state.doc, doc).mapping;
    }
    const tr = state.tr;
    for (const step of changeTo(state.doc, next).steps) tr.step(step);
    if (this.fence) this.fence.pos = mapping.map(this.fence.pos);
    tr.setSelection(state.selection.map(tr.doc, mapping));
    const kept = held?.step.map(mapping);
    const shown = kept?.apply(next).doc;
    if (held && kept instanceof ReplaceStep && shown && trailingBreak([kept], shown, next)) {
      tr.step(kept);
      this.view.updateState(state.apply(tr));
      this.held = { ...held, step: kept, base: next, doc: this.view.state.doc, before: mapSelection(held.before, mapping) };
      return;
    }
    this.view.updateState(state.apply(tr));
  }

  /** What was typed while the code block now shown was being made. */
  get typedForCodeBlock(): string {
    return this.fenceTyped;
  }

  private flush() {
    if (this.inFlight || this.epoch < 0) return;
    const next = this.queue.shift();
    if (next) {
      const { doc, ...edit } = next;
      this.inFlight = true;
      this.sent = doc;
      this.post({
        kind: "fluid-transaction",
        epoch: this.epoch,
        operation: ++this.operation,
        ...edit,
      });
    } else if (this.fence && !this.fence.sent) {
      // Every earlier edit is checked, so the parent has this paragraph too.
      this.fence.sent = true;
      this.post({ kind: "fluid-pending", pending: false });
      this.post({ kind: "fluid-code-fence", epoch: this.epoch, pos: this.fence.pos });
    } else if (this.historyPending) {
      const direction = this.historyPending;
      this.historyPending = null;
      this.post({ kind: "fluid-pending", pending: false });
      this.post({ kind: "fluid-history", epoch: this.epoch, direction });
    } else {
      this.post({ kind: "fluid-pending", pending: false });
    }
  }

  receive(message: RenderMessage) {
    const fluid = message.fluid;
    if (!fluid) return;
    const reset = fluid.reset || fluid.epoch !== this.epoch;
    this.session = message.session;
    this.revision = message.revision;
    // The new document has the code block, if the parent made one.
    this.fenceTyped = reset && this.fence ? this.fence.typed : "";
    if (reset) {
      this.fence = null;
      this.epoch = fluid.epoch;
      this.operation = fluid.operation;
      this.inFlight = false;
      this.sent = null;
      this.queue = [];
      this.historyPending = null;
      this.group++;
      const doc = fluidSchema.nodeFromJSON(fluid.doc);
      let state = EditorState.create({ doc, plugins: this.view.state.plugins });
      if (fluid.selection) {
        const clamp = (value: number) =>
          Math.max(0, Math.min(value, doc.content.size));
        state = state.apply(
          state.tr.setSelection(
            TextSelection.between(
              doc.resolve(clamp(fluid.selection.anchor)),
              doc.resolve(clamp(fluid.selection.head)),
            ),
          ),
        );
      }
      this.view.updateState(state);
      if (fluid.selection) this.view.focus();
    } else if (fluid.operation === this.operation) {
      // The optimistic document and selection are already ahead during a
      // burst. An ack only advances authority; it never overwrites that view,
      // except with the nearest form Markdown can store of the edit in flight.
      if (fluid.nearest && this.inFlight && this.sent)
        this.takeNearest(fluidSchema.nodeFromJSON(fluid.doc), this.sent);
      this.inFlight = false;
      this.sent = null;
    }
    // The render may have changed whether the document is read-only.
    if (this.view.editable === isReadOnly()) {
      this.view.setProps({});
      for (const box of this.view.dom.querySelectorAll<HTMLInputElement>(".task-list-check"))
        box.disabled = !this.view.editable;
    }
    this.post({ kind: "rendered" });
    this.flush();
  }

  /** The note revision the document on screen was rendered from. */
  get shownRevision(): number {
    return this.revision;
  }

  /** Source boundary metadata describes only edits the parent has confirmed. */
  get hasPendingEdits(): boolean {
    return this.inFlight || this.queue.length > 0 || this.fence !== null || this.heldBreak() !== null;
  }

  /** Mark commented text: every mark is replaced. */
  setCommentMarks(marks: CommentMarkRange[]) {
    this.view.dispatch(this.view.state.tr.setMeta(commentMarksKey, { marks } satisfies CommentMarksMeta));
  }

  /**
   * Scroll commented text (a document range) into view and flash it;
   * `focus` puts the caret at its start and takes the keyboard.
   */
  revealCommentRange(from: number, to: number, focus: boolean) {
    const { doc } = this.view.state;
    const start = Math.max(0, Math.min(from, doc.content.size));
    const end = Math.max(start, Math.min(to, doc.content.size));
    const tr = this.view.state.tr.setMeta(commentMarksKey, { flash: { from: start, to: end } } satisfies CommentMarksMeta);
    if (focus) tr.setSelection(TextSelection.near(doc.resolve(start)));
    this.view.dispatch(tr);
    if (focus) this.view.focus();
    const element = this.view.dom.querySelector(".comment-highlight-flash");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.view.dispatch(this.view.state.tr.setMeta(commentMarksKey, { flash: null } satisfies CommentMarksMeta));
    }, 1500);
  }

  destroy() {
    window.clearTimeout(this.flashTimer);
    this.queue = [];
    this.held = null;
    this.view.destroy();
  }
}
