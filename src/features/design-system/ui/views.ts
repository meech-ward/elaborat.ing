// A file's three views, in switch and shortcut order. A note's are Source,
// Split and Rendered; a drawing's or diagram's are Code, Split and Canvas,
// as the C5 full-screen drawing and diagram name them. The values stay the
// same, so switching files keeps the view.

export type EditorView = "source" | "split" | "rendered"

/** Which names the views go by: a note's, or a drawing's or diagram's. */
export type ViewNames = "note" | "canvas"

export const EDITOR_VIEWS: readonly { value: EditorView; label: string; digit: 1 | 2 | 3 }[] = [
  { value: "source", label: "Source", digit: 1 },
  { value: "split", label: "Split", digit: 2 },
  { value: "rendered", label: "Rendered", digit: 3 },
]

const CANVAS_LABELS: Record<EditorView, string> = { source: "Code", split: "Split", rendered: "Canvas" }

/** A view's name: EDITOR_VIEWS' label for a note, Code, Split or Canvas for a drawing or diagram. */
export function viewLabel(view: EditorView, names: ViewNames = "note"): string {
  if (names === "canvas") return CANVAS_LABELS[view]
  return EDITOR_VIEWS.find((entry) => entry.value === view)?.label ?? view
}

/**
 * The view after a toggle group change. The switch always has one view on:
 * pressing the active view (an empty change) keeps it, and a value the
 * switch does not offer is never selected.
 */
export function mandatoryView(
  current: EditorView,
  next: readonly string[],
  offered: readonly EditorView[],
): EditorView {
  const known = next.filter((value): value is EditorView => offered.includes(value as EditorView))
  return known[0] ?? current
}
