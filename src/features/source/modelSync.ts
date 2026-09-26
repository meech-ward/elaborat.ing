/**
 * Pure model-sync helpers for the source editor (tested with bun:test).
 *
 * The Monaco model is created once per mount and owns undo history. Typing
 * and rendered patches flow model -> store, but opening a file flows store
 * -> model: the displayed text must be replaced and the old document's undo
 * history must not leak into the new one.
 */

export type EditorLanguage = "markdown" | "mdx"

export function languageForFormat(format: "md" | "mdx"): EditorLanguage {
  return format === "md" ? "markdown" : "mdx"
}

export interface TextModelLike {
  getValue(): string
  setValue(value: string): void
}

/** Store-side document state: text plus the identity that owns undo. */
export interface ModelDocumentState {
  text: string
  docId: number
}

/** Model events and parent acknowledgements meet at this per-editor boundary. */
export function createModelDocumentSync(initial: ModelDocumentState) {
  let previous = initial
  const pending: string[] = []
  let replacing = false
  return {
    emitted(text: string) {
      if (!replacing) pending.push(text)
    },
    receive(model: TextModelLike, next: ModelDocumentState): boolean {
      if (previous.docId === next.docId) {
        // A React commit can acknowledge an older model event after another
        // keystroke. It is an acknowledgement, not an external replacement.
        const acknowledged = pending.indexOf(next.text)
        if (acknowledged !== -1) {
          pending.splice(0, acknowledged + 1)
          previous = next
          return false
        }
        // A render for language/other props can still carry the last accepted
        // text while the model has unacknowledged edits.
        if (previous.text === next.text) return false
      }
      replacing = true
      try {
        return syncModelDocument(model, previous, next)
      } finally {
        replacing = false
        pending.length = 0
        previous = next
      }
    },
  }
}

/**
 * Replace the model text when it differs from the document (file open).
 * Returns true when a replacement happened. `setValue` resets undo, which
 * is exactly the isolation an opened file needs; callers only invoke this
 * when the difference came from outside the model, so no edit is lost.
 */
export function syncModelText(model: TextModelLike, text: string): boolean {
  if (model.getValue() === text) return false
  model.setValue(text)
  return true
}

/**
 * Sync the model to a new store state. A document-identity change always
 * replaces the model text, even when the bytes match: Monaco's setValue
 * unconditionally flushes the model (verified in monaco-editor@0.56.0
 * `TextModel._setValueFromTextBuffer`, which clears the command manager),
 * so reopening the same bytes still isolates the old file's undo history.
 * Same-document sync keeps the cheap text-only comparison.
 */
export function syncModelDocument(
  model: TextModelLike,
  prev: ModelDocumentState,
  next: ModelDocumentState,
): boolean {
  if (prev.docId !== next.docId) {
    model.setValue(next.text)
    return true
  }
  return syncModelText(model, next.text)
}
