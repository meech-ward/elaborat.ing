import { useEffect, useMemo, useRef } from "react";
import { useCompactWorkbench } from "./compactWorkbench";
import type { ViewSwitchOption } from "./ViewSwitcher";
import { ariaShortcut, isApplePlatform, shortcutLabel, viewShortcutDigit } from "./viewShortcuts";

/**
 * A drawing's or a diagram's views, in switch and shortcut order (⌘⌥1 to 3,
 * Ctrl+Alt+1 to 3), named as a note's are: the canvas is "Rendered".
 */
export type CanvasView = "source" | "split" | "canvas";
const CANVAS_VIEWS = [
  { value: "source", label: "Source" },
  { value: "split", label: "Split" },
  { value: "canvas", label: "Rendered" },
] as const;

/** A remembered view as a canvas view. A diagram's earlier "code" is its source. */
export function canvasViewFrom(stored: string | null): CanvasView {
  if (stored === "source" || stored === "code") return "source";
  return stored === "split" ? "split" : "canvas";
}

/**
 * The view a drawing or diagram shows, its switch's options, and the view
 * keys while it is the active file. Split is desktop only: at compact widths
 * a remembered Split shows the canvas.
 */
export function useCanvasViews(mode: CanvasView, active: boolean, onSelect: (view: CanvasView) => void) {
  const compact = useCompactWorkbench();
  const view: CanvasView = mode === "split" && compact ? "canvas" : mode;
  const apple = useMemo(() => isApplePlatform(), []);
  const options = useMemo<ViewSwitchOption<CanvasView>[]>(
    () =>
      CANVAS_VIEWS.map((option, index) => ({
        ...option,
        title: `${option.label} (${shortcutLabel(index + 1, apple)})`,
        keyShortcuts: ariaShortcut(index + 1, apple),
      })).filter((option) => !compact || option.value !== "split"),
    [apple, compact],
  );
  const select = useRef({ view, onSelect });
  useEffect(() => {
    select.current = { view, onSelect };
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      const digit = viewShortcutDigit(event, apple);
      if (digit === null) return;
      const next = CANVAS_VIEWS[digit - 1].value;
      if (!options.some((option) => option.value === next)) return;
      event.preventDefault();
      event.stopPropagation();
      if (next !== select.current.view) select.current.onSelect(next);
    };
    // Capture, so a focused source editor or canvas cannot keep the keys.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, apple, options]);
  return { view, options };
}
