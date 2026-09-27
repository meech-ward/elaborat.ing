import type { ReactNode } from "react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"

/**
 * Two panes side by side, as Split shows a file's source and its rendered
 * view: shadcn's resizable panels with the divider as a 1px panelBorder line
 * that turns accent under the pointer, on keyboard focus and while dragged.
 * Arrow keys move it when it has focus.
 */
export function SplitPanes({
  start,
  end,
  startSize = "50%",
  "aria-label": ariaLabel = "Resize the panes",
  className,
}: {
  start: ReactNode
  end: ReactNode
  /** The first pane's share at the start, as a percentage ("50%") or in pixels ("320px"). */
  startSize?: string
  /** The divider's name, e.g. "Resize the source and the rendered note". */
  "aria-label"?: string
  className?: string
}) {
  return (
    <ResizablePanelGroup orientation="horizontal" className={className} resizeTargetMinimumSize={{ fine: 8, coarse: 40 }}>
      <ResizablePanel defaultSize={startSize} minSize="20%" className="min-w-0">
        {start}
      </ResizablePanel>
      <ResizableHandle
        aria-label={ariaLabel}
        className="z-10 bg-border transition-colors outline-none hover:bg-primary focus-visible:bg-primary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid data-[separator=active]:bg-primary motion-reduce:transition-none"
      />
      <ResizablePanel minSize="20%" className="min-w-0">
        {end}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
