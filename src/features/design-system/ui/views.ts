// A file's three views, in switch and shortcut order. Every file kind uses
// the same names: a drawing's or diagram's canvas is its "Rendered" view.

export type EditorView = "source" | "split" | "rendered"

export const EDITOR_VIEWS: readonly { value: EditorView; label: string; digit: 1 | 2 | 3 }[] = [
  { value: "source", label: "Source", digit: 1 },
  { value: "split", label: "Split", digit: 2 },
  { value: "rendered", label: "Rendered", digit: 3 },
]

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
