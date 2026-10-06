/**
 * The chat card's live view as a module of its own, which the card loads
 * from elaborat.ing when a new note, drawing or diagram starts to come in
 * (../modules.ts): the server's renderers and the drawing in. Built into
 * public/chat-card by `bun run build:chat-card`.
 */
export { mountLive } from "../live/mount"
