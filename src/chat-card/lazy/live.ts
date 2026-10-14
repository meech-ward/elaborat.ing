/**
 * The chat card's live view as a module of its own, which the card loads
 * from elaborat.ing when a note, drawing or diagram starts to come in
 * (../modules.ts): the server's renderers, the drawing in and its pencil
 * sound. Built into public/chat-card by `bun run build:chat-card`.
 */
export { mountLive } from "../live/mount"
