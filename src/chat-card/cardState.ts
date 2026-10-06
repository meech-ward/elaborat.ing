/**
 * What the chat card shows, as one state and the events that change it. The
 * card loads (the tool is running), shows a new file live while the agent
 * writes it (create_and_show), shows a problem, or shows a file. A
 * shown note is read, edited, or held in conflict after a save found a newer
 * version; `busy` covers the editor starting, a save and a reload.
 */
import type { CardFile } from "./toolResult"

export type CardMode = "read" | "edit" | "conflict"
export type CardBannerTone = "warn" | "danger" | "info"
export type CardBanner = { tone: CardBannerTone; text: string }
export type CardStatus = { kind: "none" } | { kind: "saving" } | { kind: "saved"; version: number }

/** What a live card shows being made. */
export type LiveKind = "note" | "drawing" | "diagram"

export type CardState =
  | { phase: "loading"; path: string | null }
  /** A new file shown as it is written, until it is saved. */
  | { phase: "live"; path: string; kind: LiveKind }
  | { phase: "problem"; message: string; tone: CardBannerTone }
  | {
      phase: "shown"
      file: CardFile
      mode: CardMode
      busy: boolean
      /** The edited note differs from where the edit started. */
      dirty: boolean
      status: CardStatus
      banner: CardBanner | null
    }

export type CardEvent =
  /** The host's tool input or result, or its cancel. Ignored while the note is being edited. */
  | { type: "input"; path: string }
  /** A new file's content has started to come in: from loading, the card goes live. */
  | { type: "live"; path: string; kind: LiveKind }
  | { type: "result"; file: CardFile }
  | { type: "problem"; message: string; tone: CardBannerTone }
  | { type: "start-edit" }
  | { type: "editor-ready" }
  | { type: "editor-failed" }
  | { type: "notice"; text: string | null }
  | { type: "dirty"; dirty: boolean }
  | { type: "cancel" }
  | { type: "saving" }
  | { type: "save-failed"; message: string }
  | { type: "conflict" }
  | { type: "reloading" }
  /** The note as saved, from the server; `version` is the save that led here, if any. */
  | { type: "reloaded"; file: CardFile; version: number | null }
  /** Saved, but the card could not load it: editing goes on from the saved text. */
  | { type: "saved-not-reloaded"; source: string; version: number }
  | { type: "reload-failed" }

export const INITIAL_CARD_STATE: CardState = { phase: "loading", path: null }

const NONE: CardStatus = { kind: "none" }

export const CARD_TEXT = {
  cannotEdit: "This note cannot be edited here. Open it in elaborat.ing to change it.",
  editorNotLoaded: "This chat did not let the editor load from elaborat.ing. Open the note there to change it.",
  conflict: "This note changed since it was loaded, so your edit was not saved. Load the latest version to edit it again.",
  reloadFailed: "The latest version could not be loaded. Open it in elaborat.ing.",
  notSaved: (message: string) => (message ? `Not saved: ${message}` : "Not saved. Try again."),
}

const shownRead = (file: CardFile, status: CardStatus = NONE): CardState => ({
  phase: "shown",
  file,
  mode: "read",
  busy: false,
  dirty: false,
  status,
  banner: null,
})

const editing = (state: CardState) => state.phase === "shown" && state.mode !== "read"

export function cardReducer(state: CardState, event: CardEvent): CardState {
  switch (event.type) {
    case "input":
      return state.phase === "loading" ? { phase: "loading", path: event.path } : state
    case "live":
      return state.phase === "loading" ? { phase: "live", path: event.path, kind: event.kind } : state
    case "result":
      return editing(state) ? state : shownRead(event.file)
    case "problem":
      return editing(state) ? state : { phase: "problem", message: event.message, tone: event.tone }
    case "reloaded":
      return shownRead(event.file, event.version === null ? NONE : { kind: "saved", version: event.version })
  }
  if (state.phase !== "shown") return state
  switch (event.type) {
    case "start-edit":
      if (state.mode !== "read" || state.busy || state.file.source === null) return state
      return { ...state, mode: "edit", busy: true, dirty: false, status: NONE, banner: null }
    case "editor-ready":
      return { ...state, busy: false, dirty: false }
    case "editor-failed":
      return { ...state, mode: "read", busy: false, banner: { tone: "warn", text: CARD_TEXT.cannotEdit } }
    case "notice":
      if (!editing(state)) return state
      return { ...state, banner: event.text === null ? null : { tone: "warn", text: event.text } }
    case "dirty":
      return { ...state, dirty: event.dirty }
    case "cancel":
      return { ...state, mode: "read", busy: false, dirty: false, status: NONE, banner: null }
    case "saving":
      return { ...state, busy: true, status: { kind: "saving" }, banner: null }
    case "save-failed":
      // Save stays on, to try again.
      return { ...state, mode: "edit", busy: false, dirty: true, status: NONE, banner: { tone: "danger", text: CARD_TEXT.notSaved(event.message) } }
    case "conflict":
      return { ...state, mode: "conflict", busy: false, status: NONE, banner: { tone: "warn", text: CARD_TEXT.conflict } }
    case "reloading":
      return { ...state, busy: true }
    case "saved-not-reloaded":
      return {
        ...state,
        file: { ...state.file, source: event.source, version: event.version },
        mode: "edit",
        busy: false,
        dirty: false,
        status: { kind: "saved", version: event.version },
        banner: null,
      }
    case "reload-failed":
      return { ...state, mode: "conflict", busy: false, status: NONE, banner: { tone: "danger", text: CARD_TEXT.reloadFailed } }
  }
}
