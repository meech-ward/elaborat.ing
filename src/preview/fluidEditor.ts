import {
  EditorState,
  TextSelection,
  type Transaction,
  type Command,
} from "prosemirror-state";
import { EditorView, type NodeView } from "prosemirror-view";
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
  liftListItem,
  sinkListItem,
  wrapInList,
} from "prosemirror-schema-list";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import { fluidSchema } from "../features/rendered/fluidSchema";
import { emptyListBackspace } from "../features/rendered/fluidCommands";
import type {
  RenderMessage,
  FluidSyntaxHint,
} from "../features/rendered/protocol";
import { isStructuralHistoryBoundary } from "../features/source/renderedHistory";
import { isReadOnly } from "./readOnly";

type Selection = { anchor: number; head: number };
type Operation = {
  steps: ReturnType<Transaction["steps"][number]["toJSON"]>[];
  before: Selection;
  after: Selection;
  group: string;
  syntax?: FluidSyntaxHint;
};
const selectionOf = (state: EditorState): Selection => ({
  anchor: state.selection.anchor,
  head: state.selection.head,
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
 * So take the browser's caret first. Node selections, and carets in object
 * islands, stay as ProseMirror has them.
 */
function adoptDOMCaret(view: EditorView) {
  const current = view.state.selection;
  const dom = view.dom.ownerDocument.getSelection();
  if (!(current instanceof TextSelection) || !view.hasFocus() || !dom) return;
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
        handler(...args);
      },
      timeout,
      ...rest,
    );
  }) as typeof window.setTimeout;
  // Also restore if this focus event sets no timer.
  queueMicrotask(restore);
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
  private queue: Operation[] = [];
  private group = 0;
  private lastInput = 0;
  private historyPending: "undo" | "redo" | null = null;
  private keysSinceFocus = false;
  private notifyIslands: () => void;

  constructor(mount: HTMLElement, notifyIslands: () => void) {
    this.notifyIslands = notifyIslands;
    const requestHistory =
      (direction: "undo" | "redo"): Command =>
      () => {
        this.group++;
        this.historyPending = direction;
        this.flush();
        return true;
      };
    const nodes = fluidSchema.nodes;
    this.view = new EditorView(mount, {
      state: EditorState.create({
        schema: fluidSchema,
        plugins: [
          keymap({
            "Mod-z": requestHistory("undo"),
            "Mod-Shift-z": requestHistory("redo"),
            "Mod-y": requestHistory("redo"),
            "Mod-b": toggleMark(fluidSchema.marks.strong),
            "Mod-i": toggleMark(fluidSchema.marks.em),
            "Mod-`": toggleMark(fluidSchema.marks.code),
            Enter: chainCommands(
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
              splitListItem(nodes.list_item),
              baseKeymap.Enter,
            ),
            Tab: sinkListItem(nodes.list_item),
            "Shift-Tab": liftListItem(nodes.list_item),
            ...Object.fromEntries(
              Object.entries(baseKeymap).filter(([key]) => key !== "Enter"),
            ),
            Backspace: chainCommands(emptyListBackspace, baseKeymap.Backspace),
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
      },
      // Runs before the keymap, so every key command sees the real caret.
      handleKeyDown: (view) => {
        this.keysSinceFocus = true;
        adoptDOMCaret(view);
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
          // the actual selection.
          if (event.pointerType === "touch") return false;
          if (
            !(event.target instanceof Element) ||
            !event.target.closest(
              "button,input,select,textarea,[data-authoring-from]",
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
                "button,input,select,textarea,[data-authoring-from]",
              ))
          )
            view.dom.focus({ preventScroll: true });
          return false;
        },
        blur: () => {
          this.group++;
          return false;
        },
      },
      handleTextInput: (view, from, to, text) => {
        // The finite structural Markdown shortcuts work through ordinary PM
        // transactions and the same checked source adapter, not a serializer.
        if (view.composing || from !== to) return false;
        const at = view.state.doc.resolve(from);
        if (at.marks().some((mark) => mark.type === fluidSchema.marks.code))
          return false;
        const prefix = at.parent.textBetween(0, at.parentOffset);
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
  }

  private post(message: object) {
    parent.postMessage(
      { session: this.session, revision: this.revision, ...message },
      "*",
    );
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
          "button,input,select,textarea,[data-authoring-from]",
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
    const now = performance.now();
    if (now - this.lastInput > 750 || tr.getMeta("uiEvent") === "paste")
      this.group++;
    this.lastInput = now;
    // Replacing a multi-paragraph selection starts a typing burst; its first
    // character must share the subsequent characters' one Monaco undo group.
    // Empty split/join and formatting commands remain explicit boundaries.
    const structural = isStructuralHistoryBoundary(
      this.view.state.doc.childCount,
      tr.doc.childCount,
      tr.steps.map((step) => step.toJSON()),
    );
    if (structural) this.group++;
    const before = selectionOf(this.view.state);
    this.view.updateState(this.view.state.apply(tr));
    this.queue.push({
      steps: tr.steps.map((step) => step.toJSON()),
      before,
      after: selectionOf(this.view.state),
      group: `${this.epoch}:${this.group}`,
      syntax: tr.getMeta("fluidSyntax"),
    });
    if (!this.inFlight && this.queue.length === 1)
      this.post({ kind: "fluid-pending", pending: true });
    if (structural) this.group++;
    this.flush();
  }

  private flush() {
    if (this.inFlight || this.epoch < 0) return;
    const next = this.queue.shift();
    if (next) {
      this.inFlight = true;
      this.post({
        kind: "fluid-transaction",
        epoch: this.epoch,
        operation: ++this.operation,
        ...next,
      });
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
    if (reset) {
      this.epoch = fluid.epoch;
      this.operation = fluid.operation;
      this.inFlight = false;
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
      // burst. An ack only advances authority; it never overwrites that view.
      this.inFlight = false;
    }
    // The render may have changed whether the document is read-only.
    if (this.view.editable === isReadOnly()) this.view.setProps({});
    this.post({ kind: "rendered" });
    this.flush();
  }

  destroy() {
    this.queue = [];
    this.view.destroy();
  }
}
