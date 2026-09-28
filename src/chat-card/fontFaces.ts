/**
 * Adds fonts by address. The card adds its own with this (fonts.ts) and hands
 * the same sources to the component preview's frame, which adds them the same
 * way. The view declares the fonts' origin, which puts it in the policy's
 * font-src; where a host does not allow it, a font does not load and the
 * host's fonts or the system's stand in.
 */

/** A font's family, its file's address, and its weight range. */
export type FontSource = readonly [family: string, url: string, weight: string]

/** Adds each font under its family name. A font that does not load is left out. */
export function addFonts(sources: readonly FontSource[]) {
  for (const [family, url, weight] of sources) {
    try {
      const face = new FontFace(family, `url(${JSON.stringify(url)})`, { weight, style: "normal", display: "swap" })
      document.fonts.add(face)
      face.load().catch(() => document.fonts.delete(face))
    } catch {
      // The system's font stands in.
    }
  }
}
