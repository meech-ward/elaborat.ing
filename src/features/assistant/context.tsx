import { createContext, useContext } from "react"
import { AssistantButton } from "@/features/design-system"

/** Whether the assistant is open and working, and a way to open it: the workbench provides it with VITE_CHATGPT_PLAN. */
export type AssistantUi = { open: boolean; busy: boolean; setOpen: (open: boolean) => void }

const AssistantUiContext = createContext<AssistantUi | null>(null)

export const AssistantUiProvider = AssistantUiContext.Provider

/** The assistant's button: in the editor's top line on a desktop, over the file on a phone (`touch`). Nothing without the provider. */
export function AssistantToggle({ size = "default" }: { size?: "default" | "touch" }) {
  const ui = useContext(AssistantUiContext)
  if (!ui) return null
  return <AssistantButton data-assistant-toggle="" size={size} pressed={ui.open} busy={ui.busy} onClick={() => ui.setOpen(!ui.open)} />
}
