import type { ComponentProps } from "react"
import { Banner, BannerAction, LoadingLine } from "@/features/design-system"
import { moduleLoader, useModule } from "@/lib/moduleLoader"
import type { WorkspaceSession } from "./WorkspaceSession"

const session = moduleLoader(() => import("./WorkspaceSession"))

/** File editing and preview orchestration starts when a file actually opens. */
export function LazyWorkspaceSession(props: ComponentProps<typeof WorkspaceSession>) {
  const { module, error, retry } = useModule(session, true)
  if (module) return <module.WorkspaceSession {...props} />
  return <div className="flex h-full min-h-0 flex-col">
    <p className="truncate border-b border-border px-4 py-2 text-sm text-muted-foreground">{props.initial.path}</p>
    {error
      ? <Banner tone="danger" className="m-2" action={<BannerAction onClick={retry}>Try again</BannerAction>}>The file editor could not load.</Banner>
      : <LoadingLine label="Loading file" />}
  </div>
}
