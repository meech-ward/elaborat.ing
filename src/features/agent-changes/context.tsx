import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react"
import type { AgentChangesState, ProjectAgentChanges } from "./store"

// The open project's agent changes for everything on its page: the button
// in the project's top line, the view, and the comments' version links.
// ProjectPage provides it for a project on the server; the local project
// has none, and nothing offers agent changes.

const AgentChangesContext = createContext<ProjectAgentChanges | null>(null)

export function AgentChangesProvider({ value, children }: { value: ProjectAgentChanges | null; children: ReactNode }) {
  return <AgentChangesContext value={value}>{children}</AgentChangesContext>
}

/** The open project's agent changes, or null where there are none. */
export function useAgentChanges(): ProjectAgentChanges | null {
  return useContext(AgentChangesContext)
}

const NO_STATE: AgentChangesState = { count: null, open: false, focus: null }
const noSubscription = () => () => {}

/** The count and whether the view is open, re-rendering on change. */
export function useAgentChangesState(): AgentChangesState {
  const store = useAgentChanges()
  return useSyncExternalStore(store?.subscribe ?? noSubscription, store ? store.getState : () => NO_STATE)
}
