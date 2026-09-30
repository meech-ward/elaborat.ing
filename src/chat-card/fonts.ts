/**
 * The app's fonts for the chat card: Space Grotesk and JetBrains Mono, and
 * Excalifont for the text in drawings (its Latin subset), as files beside the
 * card's modules on elaborat.ing (scripts/build-chat-card.ts copies them
 * there and sets their addresses). In ChatGPT the card's own text is in the
 * host's or the system's fonts instead (bridge.ts), so only Excalifont loads
 * there: it is part of how a drawing looks. The component preview's frame
 * gets the same fonts from the card (preview/ComponentPreview.tsx).
 */
import { addFonts, type FontSource } from "./fontFaces"

/** The fonts under the names the app's tokens use, which scripts/build-chat-card.ts sets. */
declare const CARD_FONT_FILES: readonly FontSource[]

/** The font drawings are written in, which loads in every host. */
const DRAWING_FONT = "Excalifont"

let drawingFontOnly = false

export const cardFonts = (): readonly FontSource[] =>
  drawingFontOnly ? CARD_FONT_FILES.filter(([family]) => family === DRAWING_FONT) : CARD_FONT_FILES

/** Adds the card's fonts; with `hostFonts`, only the drawings' font. */
export function addCardFonts(hostFonts: boolean) {
  drawingFontOnly = hostFonts
  addFonts(cardFonts())
}
