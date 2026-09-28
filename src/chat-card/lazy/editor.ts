/**
 * The chat card's note editor as a module of its own, which the card loads
 * from elaborat.ing when Edit is pressed (../modules.ts). Built into
 * public/chat-card by `bun run build:chat-card`.
 */
// First, before any module makes a schema: the view's policy has no 'unsafe-eval'.
import "../jitless"

export { startCardEditor } from "../cardEditor"
