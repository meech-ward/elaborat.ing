/**
 * The chat card's diagram drawing as a module of its own, which the card
 * loads from elaborat.ing for a D2 diagram the app has not drawn from its
 * source yet (../modules.ts): the app's D2 code, and the worker that runs
 * D2's engine, whose scripts load from there too (../diagram/d2Engine.ts).
 * Built into public/chat-card by `bun run build:chat-card`.
 */
// First, before any module makes a schema: the view's policy has no 'unsafe-eval'.
import "../jitless"

export { drawDiagram, startEngine } from "../diagram/draw"
