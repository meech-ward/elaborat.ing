import { applySourcePatches, type DocumentSnapshot, type SourcePatch } from "@/features/document"

/**
 * Workbench buffer state: the authoritative snapshot plus save tracking.
 *
 * `dirty` means the text differs from the saved copy: the store keeps the
 * text the document was opened or last saved with, and every change compares
 * against it, so undoing back to the saved text is clean again. A note that
 * was never saved opens from empty text, so it stays dirty while it has any.
 *
 * `docId` is the opened-document identity: it bumps only on replaceDocument
 * (file open / new document), never on typing, patches or save. The source
 * editor keys its Monaco model on it so reopening the same bytes still
 * resets the old file's undo history (see modelSync.syncModelDocument).
 */
export interface StoreState extends DocumentSnapshot {
  dirty: boolean
  docId: number
}

/** `initialText` is the saved copy's text, or "" for a note that was never saved. */
export function createDocumentStore(initialText: string, format: DocumentSnapshot["format"]) {
  let state: StoreState = { text: initialText, revision: 1, format, dirty: false, docId: 1 }
  let saved = initialText

  const snapshot = (): StoreState => ({ ...state })

  return {
    snapshot,

    /**
     * Source typed in the editor. Identical text is a deliberate no-op: the
     * revision stays put so a no-op round trip stays byte-identical.
     */
    setText(text: string): StoreState {
      if (text === state.text) return snapshot()
      state = { ...state, text, revision: state.revision + 1, dirty: text !== saved }
      return snapshot()
    },

    /**
     * Opened file. The buffer now matches the source of truth and is its
     * saved copy, so dirty clears; the document identity always advances,
     * even when the new bytes equal the old ones, so the editor drops the old
     * undo history.
     */
    replaceDocument(text: string, nextFormat: DocumentSnapshot["format"]): StoreState {
      saved = text
      state = { text, revision: state.revision + 1, format: nextFormat, dirty: false, docId: state.docId + 1 }
      return snapshot()
    },

    /**
     * Restored stashed draft (returning from a referenced file), with the
     * saved copy it was made on. A draft that differs from it is dirty:
     * leaving without saving must warn. Identity still advances so the
     * canvas view's undo history never leaks into the note.
     */
    restoreUnsaved(text: string, nextFormat: DocumentSnapshot["format"], savedText: string): StoreState {
      saved = savedText
      state = { text, revision: state.revision + 1, format: nextFormat, dirty: text !== saved, docId: state.docId + 1 }
      return snapshot()
    },

    /**
     * Patches from the rendered view, applied through the document module's
     * checked applier.
     * Throws a descriptive error on stale revision, overlap, invalid offsets
     * or expected-text mismatch; the buffer is untouched in that case.
     */
    applyPatches(revision: number, patches: SourcePatch[]): StoreState {
      const current: DocumentSnapshot = {
        text: state.text,
        revision: state.revision,
        format: state.format,
      }
      const next = applySourcePatches(current, revision, patches)
      // The applier returns the same snapshot for empty/no-op patches: no new
      // revision. The document identity is shell-owned: patches never open a
      // new document.
      state = { ...next, dirty: next.text !== saved, docId: state.docId }
      return snapshot()
    },

    /**
     * `text` was saved (by default the current text). When newer edits
     * arrived during the save, they stay dirty and compare against it.
     */
    markSaved(text: string = state.text): StoreState {
      saved = text
      state = { ...state, dirty: state.text !== saved }
      return snapshot()
    },
  }
}

export type DocumentStore = ReturnType<typeof createDocumentStore>
