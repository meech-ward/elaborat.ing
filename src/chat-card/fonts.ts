/**
 * The app's fonts for the chat card: Space Grotesk and JetBrains Mono, and
 * Excalifont for the text in drawings (its Latin subset), as files beside the
 * card's modules on elaborat.ing (scripts/build-chat-card.ts copies them
 * there and sets their addresses). The host's fonts, where it gives some,
 * still come first for the card's own text (bridge.ts). The component
 * preview's frame gets the same fonts from the card
 * (preview/ComponentPreview.tsx).
 */
import { addFonts, type FontSource } from "./fontFaces"

/** The fonts under the names the app's tokens use, which scripts/build-chat-card.ts sets. */
declare const CARD_FONT_FILES: readonly FontSource[]

export const cardFonts = (): readonly FontSource[] => CARD_FONT_FILES

export function addCardFonts() {
  addFonts(cardFonts())
}
