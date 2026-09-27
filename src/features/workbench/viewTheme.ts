import { useMemo } from "react";
import { getPaletteColors, useAppearance } from "@/features/appearance";
import { beforeDarkFilter, presentDrawing, type DrawingScene } from "@/features/drawings/index.ts";
import { presentDiagramElements } from "@/features/structured/presentation";
/** Native chrome follows appearance; scene data remains unchanged. */
export function useCanvasTheme(): "light" | "dark" {
  return useAppearance().appearance.scheme;
}

/**
 * The palette's canvas colours over a drawing or a diagram, for display
 * only (see DrawingCanvas's `present`). Excalidraw's dark theme inverts the
 * canvas, so dark colours go in inverted ahead of it. The canvas is clear,
 * so the dotted background under it (canvasStage.ts) shows through.
 */
export function useCanvasPresentation(kind: "drawing" | "diagram"): (scene: DrawingScene) => DrawingScene {
  const { appearance } = useAppearance();
  return useMemo(() => {
    const palette = getPaletteColors(appearance);
    const shown = appearance.scheme === "dark" ? beforeDarkFilter : (color: string) => color;
    const canvas = { background: "transparent", stroke: shown(palette.ink) };
    if (kind === "drawing") return (scene: DrawingScene) => presentDrawing(scene, canvas);
    const diagram = { stroke: canvas.stroke, label: shown(palette.inkSoft), fill: shown(palette.d2Fill), fill2: shown(palette.d2Fill2) };
    return (scene: DrawingScene) => ({ ...presentDrawing(scene, canvas), elements: presentDiagramElements(scene.elements, diagram) });
  }, [appearance, kind]);
}
