import type { SourcePatch } from "@/features/document";
import { formatMarkdown } from "./formatMarkdown";
import { createModelDocumentSync, type TextModelLike } from "./modelSync";
import type { RenderedPatchOptions, SourceHistoryResult, SourceSelection } from "./renderedHistory";

/**
 * The code editor (Monaco) loads when Source, Split or Code first shows. Until
 * then the note's text and undo history live here: rendered edits, canvas
 * writes, undo, redo and Format keep their history, grouped as the editor
 * groups them (see `SourceEditorApi.applyExternalPatches`). When the editor
 * mounts, it replays `steps` onto a model made from `base`, so its undo
 * history is the one the file would have had with the editor there from the
 * start.
 */
export type BufferStep =
  | { kind: "patches"; patches: readonly SourcePatch[]; options?: RenderedPatchOptions }
  | { kind: "history"; direction: "undo" | "redo" }
  | { kind: "format"; text: string };

/** One undo step: the text and selection before it and after it. */
type UndoStep = { before: string; after: string; beforeSelection: SourceSelection; afterSelection: SourceSelection };

export type SourceBuffer = TextModelLike & {
  /** The text the steps start from: the file as opened, or its last outside replacement. */
  base(): string;
  steps(): readonly BufferStep[];
  /** Patches against the current text, in one undo step with the ones before them in the same `group`. */
  applyPatches(patches: readonly SourcePatch[], options?: RenderedPatchOptions): void;
  history(direction: "undo" | "redo", readOnly: boolean): SourceHistoryResult;
  /** The whole text, formatted, as one undo step. */
  replaceAll(text: string): void;
};

/** `onChange` hears every change of the text, as the editor reports its model's. */
export function createSourceBuffer(initial: string, onChange: (text: string) => void): SourceBuffer {
  let base = initial;
  let text = initial;
  let steps: BufferStep[] = [];
  let done: UndoStep[] = [];
  let undone: UndoStep[] = [];
  let open: UndoStep | null = null;
  let group: string | undefined;
  let selection: SourceSelection = { anchor: 0, head: 0 };

  // Monaco's undo stop: the open step is finished.
  const stop = () => {
    if (open) done.push(open);
    open = null;
  };
  // Monaco's edit: it joins the open step or starts one, which drops the redo steps.
  const edit = (next: string, after?: SourceSelection) => {
    if (!open) {
      open = { before: text, after: text, beforeSelection: selection, afterSelection: selection };
      undone = [];
    }
    text = next;
    if (after) selection = after;
    open.after = text;
    open.afterSelection = selection;
    onChange(text);
  };

  return {
    getValue: () => text,
    // An outside replacement (a file opened or reloaded): a new history.
    setValue(value) {
      base = value;
      text = value;
      steps = [];
      done = [];
      undone = [];
      open = null;
      group = undefined;
      selection = { anchor: 0, head: 0 };
      onChange(text);
    },
    base: () => base,
    steps: () => steps,
    applyPatches(patches, options) {
      if (patches.length === 0) return;
      if (!options?.group || options.group !== group) stop();
      if (options?.before) selection = options.before;
      steps.push({ kind: "patches", patches: [...patches], options });
      group = options?.group;
      edit(applyPatches(text, patches), options?.after);
      if (!group) stop();
    },
    history(direction, readOnly) {
      group = undefined;
      stop();
      const step = readOnly ? undefined : (direction === "undo" ? done : undone).pop();
      if (step) {
        (direction === "undo" ? undone : done).push(step);
        steps.push({ kind: "history", direction });
        text = direction === "undo" ? step.before : step.after;
        selection = direction === "undo" ? step.beforeSelection : step.afterSelection;
        onChange(text);
      }
      return { text, selection };
    },
    replaceAll(next) {
      group = undefined;
      stop();
      steps.push({ kind: "format", text: next });
      edit(next);
      stop();
    },
  };
}

/** Patch offsets are into `text` as it was before any of them, as the editor applies an edit. */
function applyPatches(text: string, patches: readonly SourcePatch[]): string {
  let result = text;
  for (const patch of [...patches].sort((a, b) => b.from - a.from)) result = result.slice(0, patch.from) + patch.insert + result.slice(patch.to);
  return result;
}

export type SourceEditorApi = {
  /** Explicit Prettier format as one undoable edit. Throws on failure. */
  formatSource(): Promise<boolean>;
  /** Checked rendered-view patches as one undoable edit. */
  applyExternalPatches(patches: SourcePatch[], options?: RenderedPatchOptions): void;
  history(direction: "undo" | "redo"): SourceHistoryResult;
  focus(): void;
  /** Scroll source[from, to) into view and flash it; `focus` puts the cursor at its start. */
  revealRange(from: number, to: number, focus: boolean): void;
};

/**
 * What the source editor's shell hands the code editor when it loads: the
 * buffer to replay, the sync that tells outside replacements from the
 * editor's own echoes, and the one API the parent holds, which sends each
 * call to the buffer until the code editor attaches and to the editor after.
 */
export type SourceHandoff = {
  /** The parent's latest callback for changed text, and whether the file cannot be changed now (undo and redo do nothing then, as in the editor). */
  connect(parent: { onChange: (text: string) => void; readOnly: boolean }): void;
  buffer: SourceBuffer;
  documentSync: ReturnType<typeof createModelDocumentSync>;
  api: SourceEditorApi;
  attached(): boolean;
  attach(editor: SourceEditorApi): void;
  detach(): void;
};

export function createSourceHandoff(text: string, docId: number): SourceHandoff {
  let parent: { onChange: (text: string) => void; readOnly: boolean } = { onChange: () => {}, readOnly: false };
  const documentSync = createModelDocumentSync({ text, docId });
  const buffer = createSourceBuffer(text, (next) => {
    documentSync.emitted(next);
    parent.onChange(next);
  });
  let editor: SourceEditorApi | null = null;
  // Asked for before the editor showed: done when it attaches.
  let pendingFocus = false;
  let pendingReveal: { from: number; to: number; focus: boolean } | null = null;
  return {
    connect(next) {
      parent = next;
    },
    buffer,
    documentSync,
    attached: () => editor !== null,
    attach(next) {
      editor = next;
      if (pendingReveal) next.revealRange(pendingReveal.from, pendingReveal.to, pendingReveal.focus);
      else if (pendingFocus) next.focus();
      pendingReveal = null;
      pendingFocus = false;
    },
    detach() {
      editor = null;
    },
    api: {
      async formatSource() {
        if (editor) return editor.formatSource();
        const current = buffer.getValue();
        const formatted = await formatMarkdown(current);
        // The editor may have loaded meanwhile; it formats its own text.
        if (editor) return (editor as SourceEditorApi).formatSource();
        if (buffer.getValue() !== current) throw new Error("Format failed: the text changed while formatting. Try again.");
        if (formatted === current) return false;
        buffer.replaceAll(formatted);
        return true;
      },
      applyExternalPatches(patches, options) {
        if (editor) editor.applyExternalPatches(patches, options);
        else buffer.applyPatches(patches, options);
      },
      history(direction) {
        return editor ? editor.history(direction) : buffer.history(direction, parent.readOnly);
      },
      focus() {
        if (editor) editor.focus();
        else pendingFocus = true;
      },
      revealRange(from, to, focus) {
        if (editor) editor.revealRange(from, to, focus);
        else pendingReveal = { from, to, focus };
      },
    },
  };
}
