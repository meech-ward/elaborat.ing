import { useEffect, useMemo, useRef } from "react";
import { EDITOR_VIEWS, isApplePlatform, type EditorView } from "@/features/design-system";
import { preloadSourceEditor } from "@/features/source";
import { useCompactWorkbench } from "./compactWorkbench";
import type { FileHeaderView } from "./FileHeader";
import { viewShortcutDigit } from "./viewShortcuts";

/**
 * A drawing's or a diagram's views, in switch and shortcut order (⌘⌥1 to 3,
 * Ctrl+Alt+1 to 3): its code, both side by side, or its canvas. The switch
 * calls them Code, Split and Canvas.
 */
export type CanvasView = "source" | "split" | "canvas";

/** A remembered view as a canvas view. A diagram's earlier "code" is its source. */
export function canvasViewFrom(stored: string | null): CanvasView {
  if (stored === "source" || stored === "code") return "source";
  return stored === "split" ? "split" : "canvas";
}

/** The view switch's value for a canvas view, and back: the canvas is the switch's third view. */
export const switchView = (view: CanvasView): EditorView => (view === "canvas" ? "rendered" : view);
export const canvasView = (view: EditorView): CanvasView => (view === "rendered" ? "canvas" : view);

/**
 * The view a drawing or diagram shows, its header's view switch, and the
 * view keys while it is the active file. Split is desktop only: at compact
 * widths a remembered Split shows the canvas.
 */
export function useCanvasViews(
  mode: CanvasView,
  active: boolean,
  onSelect: (view: CanvasView) => void,
  label: string,
): { view: CanvasView; header: FileHeaderView } {
  const compact = useCompactWorkbench();
  const view: CanvasView = mode === "split" && compact ? "canvas" : mode;
  const apple = useMemo(() => isApplePlatform(), []);
  const views = useMemo<EditorView[]>(() => (compact ? ["source", "rendered"] : ["source", "split", "rendered"]), [compact]);
  const select = useRef({ view, onSelect });
  useEffect(() => {
    select.current = { view, onSelect };
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      const digit = viewShortcutDigit(event, apple);
      if (digit === null) return;
      const next = EDITOR_VIEWS[digit - 1].value;
      if (!views.includes(next)) return;
      event.preventDefault();
      event.stopPropagation();
      if (canvasView(next) !== select.current.view) select.current.onSelect(canvasView(next));
    };
    // Capture, so a focused source editor or canvas cannot keep the keys.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, apple, views]);
  return {
    view,
    // The code editor loads when Code or Split first shows; the pointer on the switch starts it.
    header: { value: switchView(view), views, names: "canvas", label, onChange: (next) => onSelect(canvasView(next)), preload: preloadSourceEditor },
  };
}
