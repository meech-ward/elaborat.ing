import type { ReactNode } from "react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { cn } from "@/lib/utils"

/**
 * Two panes side by side, as Split shows a file's source and its rendered
 * view: shadcn's resizable panels with the divider as a 1px panelBorder line
 * that turns accent under the pointer, on keyboard focus and while dragged.
 * Arrow keys move it when it has focus.
 *
 * `show` keeps one pane on its own ("start" or "end") without unmounting
 * the other, so an editor in it keeps its state; the divider comes back
 * where it was when both show again.
 */
export function SplitPanes({
  start,
  end,
  show = "both",
  startSize = "50%",
  "aria-label": ariaLabel = "Resize the panes",
  className,
}: {
  start: ReactNode
  end: ReactNode
  /** Which panes show: both, or only the start or the end one. */
  show?: "both" | "start" | "end"
  /** The first pane's share at the start, as a percentage ("50%") or in pixels ("320px"). */
  startSize?: string
  /** The divider's name, e.g. "Resize the source and the rendered note". */
  "aria-label"?: string
  className?: string
}) {
  return (
    <ResizablePanelGroup
      orientation="horizontal"
      data-show={show}
      className={cn(
        // One pane alone fills the group; the other and the divider are
        // hidden (the panels keep their sizes for when both show again).
        "[&[data-show=end]>[data-panel]:first-child]:hidden! [&[data-show=start]>[data-panel]:last-child]:hidden! [&:not([data-show=both])>[data-panel]]:grow! [&:not([data-show=both])>[data-separator]]:hidden!",
        className,
      )}
      resizeTargetMinimumSize={{ fine: 8, coarse: 40 }}
    >
      <ResizablePanel defaultSize={startSize} minSize="20%" className="min-w-0">
        {start}
      </ResizablePanel>
      <ResizableHandle
        aria-label={ariaLabel}
        disabled={show !== "both"}
        className="z-10 bg-border transition-colors outline-none hover:bg-primary focus-visible:bg-primary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid data-[separator=active]:bg-primary motion-reduce:transition-none"
      />
      <ResizablePanel minSize="20%" className="min-w-0">
        {end}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
