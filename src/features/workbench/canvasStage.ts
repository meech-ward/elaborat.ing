import { useCallback, useEffect, useRef } from "react";

/** The spacing of the canvas's background dots at 100% zoom. */
const DOT = 22;

/**
 * On a desktop, a drawing or diagram on its canvas fills the window behind
 * the panels (workbench.css, "Full-bleed canvases"). The stage paints the
 * dotted background, moves the dots with the scene, and tells Excalidraw's
 * own controls where the canvas area is: from the side panels' right edge to
 * the comments panel's left edge (or the window's). In Split the source
 * covers the left half of the editor's area, so the controls start at its
 * middle instead. The dots paint on phones too, where the stage is the
 * screen.
 */
export function useCanvasStage(fullBleed: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onScrollChange = useCallback((scrollX: number, scrollY: number, zoom: number) => {
    const stage = ref.current;
    if (!stage) return;
    // Zoomed far out, every other dot (then every fourth...) keeps them apart.
    let size = DOT * zoom;
    while (size < DOT / 2) size *= 2;
    const offset = (scroll: number) => `${(((scroll * zoom) % size) + size) % size}px`;
    stage.style.setProperty("--canvas-dot-size", `${size}px`);
    stage.style.setProperty("--canvas-dot-x", offset(scrollX));
    stage.style.setProperty("--canvas-dot-y", offset(scrollY));
  }, []);
  useEffect(() => {
    const stage = ref.current;
    const editor = stage?.closest<HTMLElement>(".wb-main-panel");
    if (!fullBleed || !stage || !editor) return;
    // The editor panel starts 16px right of the side panels, or of the
    // window's edge, and ends 16px left of the comments panel, or of the window's edge.
    const place = () => {
      const box = editor.getBoundingClientRect();
      const half = Math.round(box.left + box.width / 2);
      stage.style.setProperty("--canvas-left", `${Math.max(0, box.left - 16)}px`);
      stage.style.setProperty("--canvas-right", `${Math.max(0, Math.round(stage.getBoundingClientRect().right - box.right - 16))}px`);
      // On the view, so the controls beside the stage can keep clear of it too.
      (stage.parentElement ?? stage).style.setProperty("--canvas-split", `${half}px`);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(editor);
    return () => observer.disconnect();
  }, [fullBleed]);
  return [ref, onScrollChange] as const;
}
