import { useAppearance } from "@/features/appearance";
/** Native chrome follows appearance; scene data remains unchanged. */
export function useCanvasTheme(): "light" | "dark" {
  return useAppearance().appearance.scheme;
}
