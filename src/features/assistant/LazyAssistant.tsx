import { Banner, BannerAction, FloatingPanel, LoadingLine, PanelMessage } from "@/features/design-system"
import { moduleLoader, useModule } from "@/lib/moduleLoader"
import { cn } from "@/lib/utils"
import type { AssistantHost } from "./host"

// The assistant (its panel, the loop, the stream and argument readers, the
// tool bridge, the model picker) loads in a chunk of its own the first time
// it opens, never before; the live view of a file being written is a second
// chunk, loaded when a write starts (live.ts).
const view = moduleLoader(() => import("./AssistantView"))

export type AssistantProps = {
  host: AssistantHost
  /** A phone: the sheet from the bottom; else the panel beside the file. */
  compact: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The assistant started or stopped working (the button's dot). */
  onBusyChange: (busy: boolean) => void
  className?: string
}

/** The assistant once its chunk has loaded; until then, its panel's frame with a loading line, or Try again. */
export function LazyAssistant(props: AssistantProps) {
  const { module, error, retry } = useModule(view, props.open)
  if (module) {
    const { AssistantView } = module
    return <AssistantView {...props} />
  }
  if (!props.open) return null
  return (
    <FloatingPanel
      render={<aside aria-label="Assistant" />}
      className={cn(
        "flex shrink-0 flex-col gap-3 overflow-hidden",
        props.compact ? "fixed inset-x-0 bottom-0 z-50 h-[75svh] rounded-b-none" : "h-full w-[360px] max-w-full",
        props.className,
      )}
    >
      {error ? (
        <Banner tone="danger" className="m-3" action={<BannerAction onClick={retry}>Try again</BannerAction>}>
          The assistant could not load.
        </Banner>
      ) : (
        <>
          <LoadingLine label="Loading the assistant" />
          <PanelMessage role="status" size={props.compact ? "touch" : "default"} className="px-3.5">
            Loading the assistant…
          </PanelMessage>
        </>
      )}
    </FloatingPanel>
  )
}
