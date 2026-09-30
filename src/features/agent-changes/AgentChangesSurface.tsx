import { X } from "lucide-react"
import { AgentChangesButton, Banner, BannerAction, FloatingPanel, IconButton, LoadingLine } from "@/features/design-system"
import { moduleLoader, useModule } from "@/lib/moduleLoader"
import { cn } from "@/lib/utils"
import type { WorkspaceStore } from "@/features/workbench/workspaceStore"
import { useAgentChanges, useAgentChangesState } from "./context"

// The project's Agent changes: the button with the count of changes new to
// the person, and the view it opens. The view, with its list, diffs and
// Revert, loads in its own chunk the first time it opens; until then a
// panel of its shape shows a loading line.

const view = moduleLoader(() => import("./AgentChangesView"))

/** The button in the project's top line, with the count. Nothing where there are no agent changes (the local project). */
export function AgentChangesEntry({ size = "default" }: { size?: "default" | "touch" }) {
  const store = useAgentChanges()
  const { count } = useAgentChangesState()
  if (!store) return null
  return (
    <AgentChangesButton
      count={count ?? 0}
      size={size}
      onPointerEnter={() => view.preload()}
      onFocus={() => view.preload()}
      onClick={() => store.show()}
    />
  )
}

export type AgentChangesSurfaceProps = {
  /** A phone: the view is a sheet from the bottom; else from the right. */
  compact: boolean
  /** The project's files on this device: Revert saves through it, as an edit does. */
  workspace: Pick<WorkspaceStore, "listEntries" | "write" | "save">
  /** Why the project cannot be changed (a viewer, or archived): no Revert. */
  readOnly: string | null
  /** Open a file by its path on this device. */
  onOpenFile: (path: string) => void
}

/** The view while it is open: loading, then the list. */
export function AgentChangesSurface(props: AgentChangesSurfaceProps) {
  const store = useAgentChanges()
  const { open } = useAgentChangesState()
  const { module, error, retry } = useModule(view, open)
  if (!store || !open) return null
  if (module) {
    const { AgentChangesView } = module
    return <AgentChangesView store={store} {...props} />
  }
  return (
    <div className={cn("fixed z-50", props.compact ? "inset-x-0 bottom-0 h-[85svh]" : "inset-y-0 right-0 w-[min(800px,100vw)]")}>
      <FloatingPanel role="dialog" aria-label="Agent changes" className="flex h-full flex-col overflow-hidden">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border pr-2 pl-3.5">
          <span className="text-sm font-semibold">Agent changes</span>
          <IconButton label="Close agent changes" className="ml-auto" onClick={() => store.close()}>
            <X />
          </IconButton>
        </div>
        {error ? (
          <Banner tone="danger" className="m-3" action={<BannerAction onClick={retry}>Try again</BannerAction>}>
            Agent changes could not load.
          </Banner>
        ) : (
          <LoadingLine label="Loading agent changes" />
        )}
      </FloatingPanel>
    </div>
  )
}
