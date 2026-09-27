import { useCallback, useEffect, useRef, useState } from "react";

/** The spacing of the desktop's background dots at 100% zoom. */
const DOT = 22;

/**
 * On a desktop, a drawing or diagram on its canvas fills the window behind
 * the panels (workbench.css, "Full-bleed canvases"). The stage paints the
 * dotted background, moves the dots with the scene, and tells Excalidraw's
 * own controls where the canvas area starts: the side panels' right edge.
 * In Split the source covers the left half of the editor's area, so the
 * controls start at its middle instead, and the stage reports how much of
 * the canvas the source covers (0 otherwise).
 */
export function useCanvasStage(fullBleed: boolean, split = false) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [middle, setMiddle] = useState(0);
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
    // The editor panel starts 16px right of the side panels, or of the window's edge.
    const place = () => {
      const box = editor.getBoundingClientRect();
      const half = Math.round(box.left + box.width / 2);
      stage.style.setProperty("--canvas-left", `${Math.max(0, box.left - 16)}px`);
      // On the view, so the controls beside the stage can keep clear of it too.
      (stage.parentElement ?? stage).style.setProperty("--canvas-split", `${half}px`);
      setMiddle(half);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(editor);
    return () => observer.disconnect();
  }, [fullBleed]);
  return [ref, onScrollChange, fullBleed && split ? middle : 0] as const;
}
