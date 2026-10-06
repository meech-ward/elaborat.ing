// Public entry point for the chat card (the MCP Apps view of show_file) as the
// app shows it: the card's look in each state, for the style guide. The card
// itself runs from main.tsx, in its own bundle.
export { CardView, EditorFrame, EmbedFigure, PREVIEW_TEXT, READING_CLASS, type CardPreview, type CardViewProps } from "./CardView"
export { CARD_TEXT, type CardState } from "./cardState"
export type { CardEmbed, CardFile } from "./toolResult"
export { componentCaption } from "./preview/caption"
