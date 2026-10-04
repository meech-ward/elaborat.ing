import { useRender } from "@base-ui/react/use-render"
import type { ReactElement, ReactNode } from "react"
import { cn } from "@/lib/utils"
import { FloatingPanel } from "./FloatingPanel"
import { SharpDiamond } from "./SharpDiamond"

// No shadcn primitive is a page header: the bar is a header landmark with
// two floating panels on the dotted page, as C5 floats its panels.

/**
 * The app's mark and name: the sharp diamond in the accent colour, then
 * elaborat.ing at 600. `compact` keeps the name for screen readers only on
 * screens under 480 wide.
 */
export function BrandMark({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground", className)}>
      <SharpDiamond aria-hidden="true" className="size-4 shrink-0 text-primary" />
      {compact ? <span className="max-[479px]:sr-only">elaborat.ing</span> : "elaborat.ing"}
    </span>
  )
}

/**
 * The top bar of the pages outside a project (home, sign-in, Connected
 * agents): 16 in from the edges, the brand on a 44 high panel at the left
 * (`home` is the link it renders as, such as <Link to="/" />), and `actions`
 * on a panel of their own at the right, 44 high with radius 12 and 6
 * between them, as the editor's floating header. On touch screens both
 * panels are 52 high, so the brand link and the actions reach 40. Without
 * `actions` the right panel is left out. `below` sits under the bar, 16 in
 * (a banner). `compact` is the bar of the app in a chat's panel: 8 in, with
 * 40 high panels (48 on touch screens) and the brand's name hidden under 480
 * wide, so the page below and the actions keep the room.
 */
export function AppBar({
  home,
  actions,
  below,
  size = "default",
  className,
}: {
  home: ReactElement
  actions?: ReactNode
  below?: ReactNode
  size?: "default" | "compact"
  className?: string
}) {
  const compact = size === "compact"
  const brand = useRender({
    render: home,
    props: {
      className:
        "flex h-8 items-center rounded-tool px-1.5 outline-none pointer-coarse:h-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid",
      children: <BrandMark compact={compact} />,
    },
  })
  const height = compact ? "h-10 px-1 pointer-coarse:h-12" : "h-11 px-1.5 pointer-coarse:h-[52px]"
  return (
    <header data-slot="app-bar" data-size={size} className={cn("flex flex-col", compact ? "gap-2 p-2" : "gap-3 p-3 sm:p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <FloatingPanel className={cn("flex shrink-0 items-center", height)}>{brand}</FloatingPanel>
        {actions && (
          <FloatingPanel className={cn("flex min-w-0 items-center rounded-menu", compact ? "gap-1" : "gap-1.5", height)}>{actions}</FloatingPanel>
        )}
      </div>
      {below}
    </header>
  )
}
