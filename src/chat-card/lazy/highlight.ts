/**
 * The app's code highlighter (Shiki, with its grammars) as a module of its
 * own, which the card loads from elaborat.ing after a note with a code
 * block shows (../modules.ts), as the app's rendered view loads it. Built
 * into public/chat-card by `bun run build:chat-card`.
 */
export { highlightCode } from "@/features/rendered/codeHighlight"
