/**
 * Adds fonts from bytes the page already holds: a font made that way is not
 * a request, so the MCP Apps default policy (which blocks font files) allows
 * it. The card adds its own fonts with this (fonts.ts) and hands the same
 * sources to the component preview's frame, which adds them the same way.
 */

/** A font's family, its bytes as a base64 data URL, and its weight range. */
export type FontSource = readonly [family: string, dataUrl: string, weight: string]

/** The bytes of a base64 data URL. */
function bytesOf(dataUrl: string): ArrayBuffer {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** Adds each font under its family name. A font the browser cannot read is left out. */
export function addFonts(sources: readonly FontSource[]) {
  for (const [family, data, weight] of sources) {
    try {
      const face = new FontFace(family, bytesOf(data), { weight, style: "normal" })
      document.fonts.add(face)
      face.load().catch(() => document.fonts.delete(face))
    } catch {
      // The system's font stands in.
    }
  }
}
