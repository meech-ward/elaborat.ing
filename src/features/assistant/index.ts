// The assistant on the person's ChatGPT plan (docs/architecture.md, "The
// assistant"). What pages load at once is only this: the button and its
// context, and the loader of the rest (LazyAssistant.tsx). The Settings card
// (PlanSettings.tsx) loads with Settings' sections.
//
// It is on only in a build with VITE_CHATGPT_PLAN set: a local run, whose
// dev server holds the ChatGPT tokens (vite-plugins/chatgpt-keeper.ts). Each
// place that shows it tests import.meta.env.VITE_CHATGPT_PLAN itself, which
// every build sets to a constant ("" when unset), so a build without it
// leaves all of this out. The hosted site leaves it unset.
export { AssistantToggle, AssistantUiProvider, type AssistantUi } from "./context"
export { LazyAssistant, type AssistantProps } from "./LazyAssistant"
export type { AssistantHost } from "./host"
