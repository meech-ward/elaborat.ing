import { createContext, useContext, useState, type ReactNode } from "react"
import { X } from "lucide-react"
import { Banner, BannerAction, FloatingPanel, IconButton, LoadingLine } from "@/features/design-system"
import { moduleLoader, useModule } from "@/lib/moduleLoader"
import type { WorkspaceStore } from "../workbench/workspaceStore"

const HistoryContext = createContext<((path: string) => void) | null>(null)
const historyView = moduleLoader(() => import("./FileHistoryView"))

export const useFileHistory = () => useContext(HistoryContext)

export type FileHistoryViewProps = {
  workspace: WorkspaceStore
  projectId: string
  path: string
  compact: boolean
  readOnly: string | null
  isDirty: (path: string) => boolean
  onClose: () => void
}

function HistorySurface(props: FileHistoryViewProps) {
  const { module, error, retry } = useModule(historyView, true)
  if (module) return <module.FileHistoryView {...props} />
  return <div className={props.compact ? "fixed inset-x-0 bottom-0 z-50 h-[90svh]" : "fixed inset-y-0 right-0 z-50 w-[min(800px,100vw)]"}>
    <FloatingPanel role="dialog" aria-label="Version history" className="flex h-full flex-col overflow-hidden">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-sm font-semibold">Version history</span>
        <IconButton label="Close version history" className="ml-auto" onClick={props.onClose}><X /></IconButton>
      </div>
      {error ? <Banner tone="danger" action={<BannerAction onClick={retry}>Try again</BannerAction>}>Version history could not load.</Banner> : <LoadingLine label="Loading version history" />}
    </FloatingPanel>
  </div>
}

/** The entry stays small. History data and comparisons load only when opened. */
export function FileHistoryProvider({ children, workspace, enabled, ...props }: Omit<FileHistoryViewProps, "path" | "onClose" | "projectId"> & { children: ReactNode; enabled: boolean }) {
  const [path, setPath] = useState<string | null>(null)
  return <HistoryContext value={enabled && workspace.projectId ? setPath : null}>
    {children}
    {enabled && workspace.projectId && path !== null && <HistorySurface key={`${workspace.persistenceKey}:${path}`} {...props} workspace={workspace} projectId={workspace.projectId} path={path} onClose={() => setPath(null)} />}
  </HistoryContext>
}
