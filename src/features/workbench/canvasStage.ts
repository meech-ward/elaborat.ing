import { useCallback, useEffect, useRef } from "react";

/** The spacing of the desktop's background dots at 100% zoom. */
const DOT = 22;

/**
 * On a desktop, a drawing or diagram on its canvas fills the window behind
 * the panels (workbench.css, "Full-bleed canvases"). The stage paints the
 * dotted background, moves the dots with the scene, and tells Excalidraw's
 * own controls where the canvas area starts: the side panels' right edge.
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
    // The editor panel starts 16px right of the side panels, or of the window's edge.
    const place = () => stage.style.setProperty("--canvas-left", `${Math.max(0, editor.getBoundingClientRect().left - 16)}px`);
    place();
    const observer = new ResizeObserver(place);
    observer.observe(editor);
    return () => observer.disconnect();
  }, [fullBleed]);
  return [ref, onScrollChange] as const;
}
