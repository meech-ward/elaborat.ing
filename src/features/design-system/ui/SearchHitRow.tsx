import type { ReactNode } from "react"
import { SidebarMenuItem } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { KindBadge, type FileKind } from "./KindBadge"
import { PanelRow, type PanelRowProps } from "./PanelRow"

/**
 * A file the search found, as a PanelRow in a SidebarMenu: its kind badge
 * and path on the first line, and the words around the match under it (at
 * most two lines of muted 12px, the match itself in the text colour at 600).
 * The row grows to fit both lines.
 */
export function SearchHitRow({
  path,
  kind,
  before,
  match,
  after,
  size = "default",
  className,
  ...props
}: Omit<PanelRowProps, "children"> & {
  path: string
  kind: FileKind
  before: ReactNode
  match?: ReactNode
  after?: ReactNode
}) {
  return (
    <SidebarMenuItem>
      <PanelRow size={size} className={cn("h-auto py-1.5 pointer-coarse:h-auto", size === "touch" && "h-auto py-2", className)} {...props}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-[7px]">
            <KindBadge kind={kind} size={size} />
            <span className="min-w-0 truncate">{path}</span>
          </span>
          <span
            className={cn(
              "line-clamp-2 whitespace-normal text-muted-foreground [overflow-wrap:anywhere]",
              size === "touch" ? "pl-7 text-[13px] leading-snug" : "pl-[23px] text-xs leading-snug",
            )}
          >
            {before}
            {match && <strong className="font-semibold text-foreground">{match}</strong>}
            {after}
          </span>
        </span>
      </PanelRow>
    </SidebarMenuItem>
  )
}
