/**
 * The app's fonts for the chat card, from the card's own script. The MCP
 * Apps default policy blocks font files (font-src falls back to 'none'), but
 * a font made from bytes the page already holds is not a request, so the
 * card adds Space Grotesk and JetBrains Mono that way, and Excalifont for the
 * text in drawings (Latin only). The host's fonts, where it gives some, still
 * come first for the card's own text (bridge.ts). The component preview's
 * frame gets the same fonts from the card (preview/ComponentPreview.tsx).
 */
import jetbrainsMono from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?inline"
import spaceGrotesk from "@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2?inline"
import { addFonts, type FontSource } from "./fontFaces"

/**
 * Excalifont's Latin subset as a base64 data URL. scripts/build-chat-card.ts
 * sets it: Excalidraw's package does not export its font files.
 */
declare const EXCALIFONT_LATIN: string

/** The fonts under the names the app's tokens use. */
export const CARD_FONTS: readonly FontSource[] = [
  ["Space Grotesk Variable", spaceGrotesk, "300 700"],
  ["JetBrains Mono Variable", jetbrainsMono, "100 800"],
  ["Excalifont", EXCALIFONT_LATIN, "400"],
]

export function addCardFonts() {
  addFonts(CARD_FONTS)
}
