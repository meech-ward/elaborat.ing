/**
 * The app's fonts for the chat card, from the card's own script. The MCP
 * Apps default policy blocks font files (font-src falls back to 'none'), but
 * a font made from bytes the page already holds is not a request, so the
 * card adds Space Grotesk and JetBrains Mono that way, and Excalifont for the
 * text in drawings (Latin only). The host's fonts, where it gives some, still
 * come first for the card's own text (bridge.ts).
 */
import jetbrainsMono from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?inline"
import spaceGrotesk from "@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2?inline"

/**
 * Excalifont's Latin subset as a base64 data URL. scripts/build-chat-card.ts
 * sets it: Excalidraw's package does not export its font files.
 */
declare const EXCALIFONT_LATIN: string

/** The bytes of a base64 data URL. */
function bytesOf(dataUrl: string): ArrayBuffer {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** Adds the fonts under the names the app's tokens use. A font the browser cannot read is left out. */
export function addCardFonts() {
  for (const [family, data, weight] of [
    ["Space Grotesk Variable", spaceGrotesk, "300 700"],
    ["JetBrains Mono Variable", jetbrainsMono, "100 800"],
    ["Excalifont", EXCALIFONT_LATIN, "400"],
  ] as const) {
    try {
      const face = new FontFace(family, bytesOf(data), { weight, style: "normal" })
      document.fonts.add(face)
      face.load().catch(() => document.fonts.delete(face))
    } catch {
      // The system's font stands in.
    }
  }
}
