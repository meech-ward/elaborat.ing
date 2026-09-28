/**
 * The chat card's component compiler as a module of its own, which the card
 * loads from elaborat.ing for a note with components or a component file
 * (../modules.ts). Built into public/chat-card by `bun run build:chat-card`.
 */
// First, before any module makes a schema: the view's policy has no 'unsafe-eval'.
import "../jitless"

export { compileComponents, compileErrorMessage, compileNote } from "../preview/compile"
