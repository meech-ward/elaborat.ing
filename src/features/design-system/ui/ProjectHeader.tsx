import { ChevronDown, Diamond, UserPlus } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ActionMenu, type MenuEntry } from "./ActionMenu"
import { FloatingPanel } from "./FloatingPanel"

const sizes = {
  // Desktop: a 44 high panel, 16px icons, the name 600 14px.
  default: {
    panel: "h-11 gap-2 pr-1.5 pl-3",
    mark: "size-4",
    name: "h-8 rounded-[8px] px-1 text-sm",
    share: "icon" as const,
    shareClass: "",
  },
  // Phone: 50 high, 20px icons, the name 600 17px and 40px targets.
  touch: {
    panel: "h-[50px] gap-2 pr-1.5 pl-3",
    mark: "size-5",
    name: "h-10 rounded-[10px] px-1 text-[17px]",
    share: "icon-lg" as const,
    shareClass: "rounded-[10px]",
  },
}

/**
 * The project panel at the top of the sidebar: the diamond mark in the
 * accent colour, the project's name as a menu button with a chevron (an
 * ActionMenu with `menu` as its entries), and the share button.
 * `children` go at the end of the panel (hidden inputs and the like).
 */
export function ProjectHeader({
  name,
  menu,
  onShare,
  shareLabel = "Share project",
  size = "default",
  variant,
  className,
  children,
}: {
  name: ReactNode
  /** The project menu's entries. */
  menu: readonly MenuEntry[]
  /** Without it the share button is left out. */
  onShare?: () => void
  shareLabel?: string
  size?: "default" | "touch"
  /** `flat` drops the panel shadow, as on phones. */
  variant?: "floating" | "flat"
  className?: string
  children?: ReactNode
}) {
  const s = sizes[size]
  return (
    <FloatingPanel variant={variant} className={cn("flex items-center", s.panel, className)}>
      <Diamond aria-hidden="true" className={cn("shrink-0 text-primary", s.mark)} />
      <ActionMenu
        entries={menu}
        trigger={
          <Button variant="ghost" className={cn("min-w-0 flex-1 justify-start gap-1.5 font-semibold text-foreground", s.name)}>
            <span className="min-w-0 flex-1 truncate text-left">{name}</span>
            <ChevronDown aria-hidden="true" className="size-4 text-dim" />
          </Button>
        }
      />
      {onShare && (
        <Button variant="ghost" size={s.share} aria-label={shareLabel} title={shareLabel} className={s.shareClass} onClick={onShare}>
          <UserPlus aria-hidden="true" />
        </Button>
      )}
      {children}
    </FloatingPanel>
  )
}
